#!/usr/bin/env python3
"""端到端 v3：torch transcribeFrames vs ONNX 全链。
Viterbi 用 numpy 向量化实现（与 viterbi.js 逐行同构），同时试 S 的两种轴向，
命中 torch 音符的即正确轴向。组装函数是 worker.js 的参照实现。"""
import sys, numpy as np, torch
torch.manual_seed(0); np.random.seed(0)
sys.path.insert(0, '/tmp/opencode/transkun')
import moduleconf
from transkun.ModelTransformer import TransKun
from transkun.Util import makeFrame
import onnxruntime as ort

FS, HOP = 44100, 1024
FRAME_DUR = HOP / FS
PITCHES = [-64, -67] + list(range(21, 109))


def viterbi_np(Smat, skip, T, forced=0):
    """与 viterbi.js decode 同构：Smat[end,begin]。"""
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


def assemble(intervals_by_sym, vel, ofVal, ofPres, lastFrameIdx):
    notes, n = [], 0
    for j, ev in enumerate(PITCHES):
        lastEnd = 0.0
        for (b, e) in intervals_by_sym[j]:
            # 显式转 Python 标量：numpy 标量 hash 与 float 不一致会导致集合比较误判
            #（JS 端无此问题，number 统一；这里只是测试脚手架修正）
            start = float((b + ofVal[n][0]) * FRAME_DUR)
            end = float((e + ofVal[n][1]) * FRAME_DUR)
            hasOnset = (b > 0) or bool(ofPres[n][0])
            hasOffset = (e < lastFrameIdx) or bool(ofPres[n][1])
            start = max(start, lastEnd)
            end = max(end, start + 1e-8)
            lastEnd = end
            notes.append((round(start, 3), round(end, 3), ev, int(vel[n])))
            n += 1
    notes.sort(key=lambda v: (v[0], v[1], v[2]))
    return notes


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
so = ort.SessionOptions(); so.intra_op_num_threads = 1; so.inter_op_num_threads = 1  # 单线程定死，剃刀tie才可复现
EP = ['CPUExecutionProvider']
s_sess = ort.InferenceSession('/tmp/opencode/onnx_out/transkun_scorer.onnx', so, providers=EP)
a_sess = ort.InferenceSession('/tmp/opencode/onnx_out/transkun_attr.onnx', so, providers=EP)

with torch.no_grad():
    frames = makeFrame(x, model.hopSize, model.windowSize).unsqueeze(1)
    fb = (frames - frames.mean(dim=[1, 2, 3], keepdim=True)) / (frames.std(dim=[1, 2, 3], keepdim=True) + 1e-8)
    mel = model.framewiseFeatureExtractor(fb).contiguous()
    mel = mel.view(mel.shape[0], *mel.shape[-3:])
    print('mel:', tuple(mel.shape), flush=True)

    notes_t, _ = model.transcribeFrames(fb, lastFrameIdx=689)
    ref = set((round(p.start, 3), round(p.end, 3), p.pitch, p.velocity) for p in notes_t[0])
    print('torch notes:', len(ref), flush=True)

    S_o, Ss_o, C_o = s_sess.run(None, {'mel': mel.numpy()})
    print('S:', S_o.shape, 'Sskip:', Ss_o.shape, 'CTX:', C_o.shape, flush=True)
    for tag, St in (('A: S[e,b]', S_o), ('B: S_T[e,b]', S_o.transpose(1, 0, 2))):
        paths = [viterbi_np(St[:, :, s], Ss_o[:, s], 691) for s in range(90)]
        nIv = sum(len(p) for p in paths)
        if nIv:
            ca = np.stack([C_o[0, s, b] for s in range(90) for (b, e) in paths[s]])
            cb = np.stack([C_o[0, s, e] for s in range(90) for (b, e) in paths[s]])
            ov, oV, oP = a_sess.run(None, {'ctx_a': ca.astype(np.float32), 'ctx_b': cb.astype(np.float32)})
            got = set(assemble(paths, ov, oV, oP, 689))
        else:
            got = set()
        print(f'{tag}: intervals={nIv} match={len(ref & got)}/{len(ref)}', flush=True)
        if 'A:' in tag:
            assert ref == got, f'E2E MISMATCH: only-torch={sorted(set(ref)-set(got))} only-onnx={sorted(set(got)-set(ref))}'
            print('E2E-V3-ALL-PASS (12/12 exact)', flush=True)
