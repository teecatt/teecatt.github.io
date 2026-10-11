#!/usr/bin/env python3
"""自验证 dump v2：逐段镜像 transcribe()（pad8s/STEP8s/forcedStart链式），落盘每段 S/Sskip/CTX/mel/ca/cb/ov/paths。
供 test_inferall_js.mjs 用 segIdx 键控 stub 驱动 worker.js 的 inferAll（真管线、真权重输出）。
用法：/usr/bin/python3 audio_to_midi/export/dump_seg.py [outdir]"""
import sys, os, json, math
import numpy as np, torch
import torch.nn.functional as F
torch.manual_seed(0); np.random.seed(0)
sys.path.insert(0, '/tmp/opencode/transkun')
import moduleconf
from transkun.ModelTransformer import TransKun
from transkun.Util import makeFrame
import onnxruntime as ort

FS, HOP = 44100, 1024
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/opencode/e2e'
os.makedirs(OUT, exist_ok=True)

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
x0 = torch.from_numpy(y.astype(np.float32)).unsqueeze(0)  # [1,T] 原始16s
y.astype(np.float32).tofile(f'{OUT}/pcm_f32.bin')

conf = moduleconf.parseFromFile('/tmp/opencode/transkun/transkun/pretrained/2.0.conf')['Model'].config
model = TransKun(conf=conf)
ckpt = torch.load('/tmp/opencode/transkun/transkun/pretrained/2.0.pt', map_location='cpu')
model.load_state_dict(ckpt['best_state_dict' if 'best_state_dict' in ckpt else 'state_dict'], strict=False)
model.eval()
so = ort.SessionOptions(); so.intra_op_num_threads = 1; so.inter_op_num_threads = 1
EP = ['CPUExecutionProvider']
s_sess = ort.InferenceSession('/tmp/opencode/onnx_out/transkun_scorer.onnx', so, providers=EP)
a_sess = ort.InferenceSession('/tmp/opencode/onnx_out/transkun_attr.onnx', so, providers=EP)


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


SEG_SEC, STEP_SEC = 16.0, 8.0
padTimeBegin = SEG_SEC - STEP_SEC  # 8.0
SEG = math.ceil(SEG_SEC * FS)      # 705600
STEP = math.ceil(STEP_SEC * FS / HOP) * HOP  # 353280
T, LAST_F, STEP_F = 691, 689, STEP // HOP  # 345

with torch.no_grad():
    xp = F.pad(x0.transpose(-1, -2) if False else x0,
               (math.ceil(padTimeBegin * FS), math.ceil(FS * padTimeBegin)))
    nSample = xp.shape[-1]
    startPos = [math.floor(padTimeBegin * FS / HOP)] * 90  # [344]*90
    seg_metas, seg_idx = [], 0
    for i in range(0, nSample, STEP):
        j = min(i + SEG, nSample)
        cur = xp[:, i:j]
        if cur.shape[-1] < SEG:
            cur = F.pad(cur, (0, SEG - cur.shape[-1]))
        frames = makeFrame(cur, model.hopSize, model.windowSize).unsqueeze(1)
        fb = (frames - frames.mean(dim=[1, 2, 3], keepdim=True)) / (frames.std(dim=[1, 2, 3], keepdim=True) + 1e-8)
        mel = model.framewiseFeatureExtractor(fb).contiguous()
        mel = mel.view(mel.shape[0], *mel.shape[-3:])
        S_o, Ss_o, C_o = s_sess.run(None, {'mel': mel.numpy()})
        paths = [viterbi_np(S_o[:, :, s], Ss_o[:, s], T, forced=startPos[s]) for s in range(90)]
        nIv = sum(len(p) for p in paths)
        ca = np.stack([C_o[0, s, b] for s in range(90) for (b, e) in paths[s]]).astype(np.float32) if nIv else np.zeros((0, 256), np.float32)
        cb = np.stack([C_o[0, s, e] for s in range(90) for (b, e) in paths[s]]).astype(np.float32) if nIv else np.zeros((0, 256), np.float32)
        if nIv:
            ov, oV, oP = a_sess.run(None, {'ctx_a': ca, 'ctx_b': cb})
        else:
            ov, oV, oP = np.zeros((0,), np.int64), np.zeros((0, 2), np.float32), np.zeros((0, 2), bool)
        # lastP 链式（与 transcribe() 逐行一致：hasOffset 的末 interval 的 e，否则 0）
        lastP = []
        n = 0
        for s in range(90):
            curLastP = 0
            for (b, e) in paths[s]:
                hasOffset = (e < LAST_F) or bool(oP[n][1])
                if hasOffset:
                    curLastP = e
                n += 1
            lastP.append(curLastP)
        np.save(f'{OUT}/seg{seg_idx}_S.npy', S_o); np.save(f'{OUT}/seg{seg_idx}_Sskip.npy', Ss_o)
        np.save(f'{OUT}/seg{seg_idx}_CTX.npy', C_o); np.save(f'{OUT}/seg{seg_idx}_mel.npy', mel.numpy())
        np.save(f'{OUT}/seg{seg_idx}_ca.npy', ca); np.save(f'{OUT}/seg{seg_idx}_cb.npy', cb)
        np.save(f'{OUT}/seg{seg_idx}_vel.npy', np.asarray(ov)); np.save(f'{OUT}/seg{seg_idx}_ofVal.npy', np.asarray(oV))
        np.save(f'{OUT}/seg{seg_idx}_ofPres.npy', np.asarray(oP))
        json.dump({'paths': [[[int(b), int(e)] for (b, e) in p] for p in paths],
                   'startPos': [int(v) for v in startPos],
                   'lastP': [int(v) for v in lastP], 'nIv': int(nIv)},
                  open(f'{OUT}/seg{seg_idx}.json', 'w'))
        print(f'seg{seg_idx}: i={i} nIv={nIv} startPos0={startPos[0]}', flush=True)
        startPos = [max(k - STEP_F, 0) for k in lastP]
        seg_idx += 1
    notes_t = model.transcribe(x0.squeeze(0).unsqueeze(-1), discardSecondHalf=False, mergeIncompleteEvent=True)  # [T,1] 时序主维（内部 transpose 后变 [C,T] 再按时间 pad）
    ref = sorted((round(p.start, 3), round(p.end, 3), p.pitch, p.velocity) for p in notes_t)
    json.dump({'ref': ref, 'nSeg': seg_idx}, open(f'{OUT}/meta.json', 'w'))
    print(f'DUMP-SEG-OK nSeg={seg_idx} ref={len(ref)} -> {OUT}', flush=True)
