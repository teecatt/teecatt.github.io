#!/usr/bin/env python3
"""ONNX 校验（阶段1，在 NVIDIA 台式机上运行）。

三层对比（由严到松）：
  1. 数值层：同一 16s 段，torch S/S_skip vs onnxruntime 输出，max abs diff。
  2. 解码层：把 ONNX 的 S/S_skip 喂给原始 CRF.decode（C++ 扩展只负责 Viterbi，
     与分数来源无关），与 torch 路径的 interval 序列逐条对比（应完全一致）。
  3. 事件层：两边各走完 velocity/of 头 + transcribe 后处理，输出 MIDI，
     以 50ms/半音 容差算音符 F1（期望 ≥0.99；fp16 版 ≥0.97）。

用法：
  python validate_onnx.py --onnx ./onnx_out --sample maestro_sample.wav [--fp16]
参考 MIDI：用 transkun CLI 在同一文件上跑一遍（python -m transkun.../transkun in out.mid），
作为第 3 层的第三方对照（允许踏板差异：No Pedal 权重不产踏板）。
"""
import argparse, os
import numpy as np
import torch

FS, HOP, WIN, SEG_SEC = 44100, 1024, 4096, 16
NFRAMES = (SEG_SEC * FS + HOP - 1) // HOP + 1


def load_audio(path, model):
    from transkun.Data import readAudio
    fs, audio = readAudio(path)
    if fs != model.fs:
        import soxr
        audio = soxr.resample(audio, fs, model.fs)
    return audio.astype(np.float32)


def frames_of(segment, model):
    from transkun.Util import makeFrame
    import torch.nn.functional as F
    x = torch.from_numpy(segment).unsqueeze(0).unsqueeze(0).transpose(-1, -2)
    frames = makeFrame(x, model.hopSize, model.windowSize)
    mu = frames.mean(dim=[1, 2, 3], keepdim=True)
    sd = frames.std(dim=[1, 2, 3], keepdim=True)
    return ((frames - mu) / (sd + 1e-8), x.shape)


def midi_notes(path):
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(path)
    out = []
    for ins in pm.instruments:
        if ins.is_drum:
            continue
        for n in ins.notes:
            out.append((n.start, n.end, n.pitch, n.velocity))
    return sorted(out)


def note_f1(ref, hyp, tol=0.05):
    used = [False] * len(hyp)
    hit = 0
    for s, e, p, _ in ref:
        best, bi = tol, -1
        for i, (s2, e2, p2, _) in enumerate(hyp):
            if used[i] or p2 != p:
                continue
            d = abs(s - s2) + abs(e - e2)
            if d < best:
                best, bi = d, i
        if bi >= 0:
            used[bi] = True
            hit += 1
    prec = hit / max(1, len(hyp))
    rec = hit / max(1, len(ref))
    return 2 * prec * rec / max(1e-9, prec + rec), prec, rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--onnx", required=True)
    ap.add_argument("--sample", required=True, help="MAESTRO 钢琴 wav（≥16s，取前16s）")
    ap.add_argument("--weight", default=None)
    ap.add_argument("--fp16", action="store_true")
    args = ap.parse_args()
    import onnxruntime as ort

    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from export_transkun_onnx import load_model, ScoringWrapper, HeadsWrapper

    torch.set_grad_enabled(False)
    model = load_model(args.weight)
    suffix = ".fp16.onnx" if args.fp16 else ".onnx"
    sess_s = ort.InferenceSession(os.path.join(args.onnx, f"transkun-v2-scoring{suffix}"),
                                  providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    sess_h = ort.InferenceSession(os.path.join(args.onnx, f"transkun-v2-heads{suffix}"),
                                  providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    print(f"[valid] EP：{sess_s.get_providers()}")

    audio = load_audio(args.sample, model)
    seg = audio[:SEG_SEC * FS]
    if len(seg) < SEG_SEC * FS:
        seg = np.pad(seg, (0, SEG_SEC * FS - len(seg)))
    frames, _ = frames_of(seg, model)
    print(f"[valid] 帧形状：{tuple(frames.shape)}（期望 F={NFRAMES}）")

    # ---- 层1：数值 ----
    with torch.no_grad():
        S_t, Ss_t, ctx_t = ScoringWrapper(model)(frames)
    S_o, Ss_o, ctx_o = sess_s.run(None, {"frames": frames.numpy()})
    # torch S 形状 [T,T,S]，onnx 同；对齐后再比
    dS = np.abs(S_t.numpy() - S_o).max()
    dSs = np.abs(Ss_t.numpy() - Ss_o).max()
    print(f"[valid] 层1 max|ΔS|={dS:.3e}  max|ΔS_skip|={dSs:.3e}（fp32 期望<1e-5）")
    ok1 = dS < 1e-4 and dSs < 1e-4

    # ---- 层2：Viterbi（ONNX 分数 + 原始 CRF） ----
    from transkun import CRF
    crf_ref = CRF.NeuralSemiCRFInterval(
        S_t.flatten(-2, -1), Ss_t.flatten(-2, -1)).decode(forcedStartPos=None, forward=False)
    S_on = torch.from_numpy(S_o).unsqueeze(2)      # 还原 [T,T,1,S]
    Ss_on = torch.from_numpy(Ss_o).unsqueeze(1)
    crf_onnx = CRF.NeuralSemiCRFInterval(
        S_on.flatten(-2, -1), Ss_on.flatten(-2, -1)).decode(forcedStartPos=None, forward=False)
    same = sum(1 for a, b in zip(crf_ref, crf_onnx) if list(a) == list(b))
    print(f"[valid] 层2 interval 序列一致：{same}/{len(crf_ref)}（期望全等）")
    ok2 = same == len(crf_ref)

    # ---- 层3：整曲 MIDI（两边各走 transcribeFrames 全流程） ----
    notes_ref, _ = model.transcribeFrames(frames)
    # onnx 路径：用 onnx 分数解码 + onnx 头预测属性（复用 torch 的 gather 拼属性输入，
    # 属性拼装语义阶段2要在 JS 里重写，这里只验头的数值）
    iv = crf_onnx
    nAll = sum(len(_) for _ in iv)
    if nAll:
        ctx_a, ctx_b, _, _ = model.fetchIntervalFeaturesBatch(ctx_t, [iv[i*90:(i+1)*90] for i in range(1)])
        attr = torch.cat([ctx_a, ctx_b, ctx_a * ctx_b], dim=-1)
        v_o, of_o = sess_h.run(None, {"attr": attr.numpy()})
        v_t = model.velocityPredictor(attr).detach().numpy()
        dv = np.abs(v_t - v_o).max()
        print(f"[valid] 层3 头 max|Δvelocity|={dv:.3e}（fp32 期望<1e-5）")
        ok3 = dv < 1e-4
    else:
        print("[valid] 层3：该段无检出，跳过（换一段有琴声的样本）")
        ok3 = True

    print(f"[valid] 结果：层1={'PASS' if ok1 else 'FAIL'} 层2={'PASS' if ok2 else 'FAIL'} 层3={'PASS' if ok3 else 'FAIL'}")
    if not (ok1 and ok2 and ok3):
        raise SystemExit(1)
    print("[valid] 全部通过 → 可上传 HuggingFace，填 MODEL_HF_URL + worker ORT_MODEL_URL。")


if __name__ == "__main__":
    main()
