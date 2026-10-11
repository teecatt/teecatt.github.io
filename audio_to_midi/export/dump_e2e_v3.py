#!/usr/bin/env python3
"""自验证 dump：16s 合成旋律 → torch mel → ONNX scorer/attr → 落盘 S/Sskip/CTX/ca/cb + torch 参考音符。
供 test_inferall_js.mjs 用真实权重输出驱动 worker.js 的 inferAll（JS 侧解码+组装）。
用法：/usr/bin/python3 audio_to_midi/export/dump_e2e_v3.py [outdir]"""
import sys, os, json
import numpy as np, torch
torch.manual_seed(0); np.random.seed(0)
sys.path.insert(0, '/tmp/opencode/transkun')
import moduleconf
from transkun.ModelTransformer import TransKun
from transkun.Util import makeFrame
import onnxruntime as ort

FS, HOP = 44100, 1024
FRAME_DUR = HOP / FS
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/opencode/e2e'
os.makedirs(OUT, exist_ok=True)

# 合成：8 个单音 + 三和弦 + 高八度（与 test_e2e_v3 同 clip，保证可比）
dur = 16.0
t = np.arange(int(FS * dur)) / FS
y = np.zeros_like(t)
melody = [(0, 261.63), (1, 293.66), (2, 329.63), (3, 392.00),
          (4, 440.00), (5, 523.25), (6, 587.33), (7, 659.25)]
for onset, f in melody + [(8, 261.63), (8, 329.63), (8, 392.00),
                          (10, 523.25), (10, 659.25), (10, 783.99)]:
    seg = t - onset
    m = seg >= 0
    a = np.minimum(1, seg * 200)
    d = np.exp(-seg * 2.2)
    ph = 2 * np.pi * f * seg
    y[m] += (np.sin(ph[m]) + 0.4 * np.sin(2 * ph[m]) + 0.2 * np.sin(3 * ph[m])) * a[m] * d[m] * 0.25
y = y / max(1e-6, np.abs(y).max()) * 0.8
x = torch.from_numpy(y.astype(np.float32)).unsqueeze(0)

conf = moduleconf.parseFromFile('/tmp/opencode/transkun/transkun/pretrained/2.0.conf')['Model'].config
model = TransKun(conf=conf)
ckpt = torch.load('/tmp/opencode/transkun/transkun/pretrained/2.0.pt', map_location='cpu')
model.load_state_dict(ckpt['best_state_dict' if 'best_state_dict' in ckpt else 'state_dict'], strict=False)
model.eval()
so = ort.SessionOptions(); so.intra_op_num_threads = 1; so.inter_op_num_threads = 1
EP = ['CPUExecutionProvider']
s_sess = ort.InferenceSession('/tmp/opencode/onnx_out/transkun_scorer.onnx', so, providers=EP)
a_sess = ort.InferenceSession('/tmp/opencode/onnx_out/transkun_attr.onnx', so, providers=EP)

with torch.no_grad():
    frames = makeFrame(x, model.hopSize, model.windowSize).unsqueeze(1)
    fb = (frames - frames.mean(dim=[1, 2, 3], keepdim=True)) / (frames.std(dim=[1, 2, 3], keepdim=True) + 1e-8)
    mel = model.framewiseFeatureExtractor(fb).contiguous()
    mel = mel.view(mel.shape[0], *mel.shape[-3:])
    notes_t, _ = model.transcribeFrames(fb, lastFrameIdx=689)
    ref = sorted((round(p.start, 3), round(p.end, 3), p.pitch, p.velocity) for p in notes_t[0])
    S_o, Ss_o, C_o = s_sess.run(None, {'mel': mel.numpy()})
    # torch 自己的 attr 输入（JS 侧 gather 必须与之逐行一致，对比用）。
    # viterbi_np 与 test_e2e_v3.py 同构（刻意复制，避免 import 触发其顶层 e2e 主流程）。
    def viterbi_np(Smat, skip, T, forced=0):
        q = np.zeros(T, dtype=np.float64)
        q[T - 1] = Smat[T - 1, T - 1] if Smat[T - 1, T - 1] > 0 else 0.0
        ptr = np.full(T, -1, dtype=np.int64)
        for pe in range(T - 2, -1, -1):
            bestV = q[pe + 1] + skip[pe]
            bestSel = -1
            cand = q[pe + 1:] + Smat[pe + 1:, pe]
            k = int(np.argmax(cand))
            if cand[k] > bestV:
                bestV, bestSel = float(cand[k]), k
            ptr[pe] = bestSel
            q[pe] = bestV + (Smat[pe, pe] if Smat[pe, pe] > 0 else 0.0)
        res = []
        j = forced
        while j < T - 1:
            if Smat[j, j] > 0:
                res.append([j, j])
            sel = ptr[j]
            if sel < 0:
                j += 1
            else:
                e2 = sel + j + 1
                res.append([j, e2])
                j = e2
        if Smat[T - 1, T - 1] > 0:
            res.append([T - 1, T - 1])
        return res
    paths = [viterbi_np(S_o[:, :, s], Ss_o[:, s], 691) for s in range(90)]
    ca = np.stack([C_o[0, s, b] for s in range(90) for (b, e) in paths[s]]).astype(np.float32)
    cb = np.stack([C_o[0, s, e] for s in range(90) for (b, e) in paths[s]]).astype(np.float32)
    ov, oV, oP = a_sess.run(None, {'ctx_a': ca, 'ctx_b': cb})

np.save(f'{OUT}/S.npy', S_o); np.save(f'{OUT}/Sskip.npy', Ss_o); np.save(f'{OUT}/CTX.npy', C_o)
np.save(f'{OUT}/ca.npy', ca); np.save(f'{OUT}/cb.npy', cb)
np.save(f'{OUT}/mel_torch.npy', mel.numpy())
y.astype(np.float32).tofile(f'{OUT}/pcm_f32.bin')
json.dump({'ref': ref, 'nSegNote': len(ref),
           'S_shape': list(S_o.shape), 'CTX_shape': list(C_o.shape)},
          open(f'{OUT}/meta.json', 'w'))
print(f'DUMP-OK ref={len(ref)} S={S_o.shape} CTX={C_o.shape} -> {OUT}', flush=True)
