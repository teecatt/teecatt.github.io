#!/usr/bin/env python3
"""功能验证：合成双音旋律 → torch 整段转录 vs ONNX 整段转录，对比音符序列。"""
import sys, types, numpy as np, torch
sys.path.insert(0, '/tmp/opencode/transkun')
stub = types.ModuleType('transkun.CRF')
from transkun.CRF import NeuralSemiCRFInterval
sys.path.insert(0, '/tmp/opencode')
from export_onnx import AttrNet
import moduleconf
from transkun.ModelTransformer import TransKun
from transkun.Util import makeFrame
import onnxruntime as ort

FS = 44100
dur = 16.0
t = np.arange(int(FS * dur)) / FS
y = np.zeros_like(t)
# 钢琴式包络：5ms 起振 + 指数衰减；8 个四分音符 + 结尾三和弦
melody = [(0, 261.63), (1, 293.66), (2, 329.63), (3, 392.00),
          (4, 440.00), (5, 523.25), (6, 587.33), (7, 659.25)]
for onset, f in melody + [(8, 261.63), (8, 329.63), (8, 392.00),
                          (10, 523.25), (10, 659.25), (10, 783.99)]:
    seg = t - onset
    m = seg >= 0
    a = np.minimum(1, seg * 200)  # 5ms attack
    d = np.exp(-seg * 2.2)        # decay
    ph = 2 * np.pi * f * seg
    y[m] += (np.sin(ph[m]) + 0.4 * np.sin(2 * ph[m]) + 0.2 * np.sin(3 * ph[m])) * a[m] * d[m] * 0.25
y = y / max(1e-6, np.abs(y).max()) * 0.8
x = torch.from_numpy(y.astype(np.float32)).unsqueeze(0)

torch.manual_seed(0)
conf = moduleconf.parseFromFile('/tmp/opencode/transkun/transkun/pretrained/2.0.conf')['Model'].config
model = TransKun(conf=conf)
ckpt = torch.load('/tmp/opencode/transkun/transkun/pretrained/2.0.pt', map_location='cpu')
model.load_state_dict(ckpt['best_state_dict' if 'best_state_dict' in ckpt else 'state_dict'], strict=False)
model.eval()
so = ort.SessionOptions(); so.intra_op_num_threads = 4
s_sess = ort.InferenceSession('/tmp/opencode/onnx_out/transkun_scorer.onnx', so, providers=['CPUExecutionProvider'])
a_sess = ort.InferenceSession('/tmp/opencode/onnx_out/transkun_attr.onnx', so, providers=['CPUExecutionProvider'])

import torch.nn.functional as _F

with torch.no_grad():
    frames = makeFrame(x, model.hopSize, model.windowSize).unsqueeze(1)  # [1,1,F,4096]
    print('frames:', tuple(frames.shape))
    fb = (frames - frames.mean(dim=[1, 2, 3], keepdim=True)) / (frames.std(dim=[1, 2, 3], keepdim=True) + 1e-8)
    mel = model.framewiseFeatureExtractor(fb).contiguous()
    mel = mel.view(mel.shape[0], *mel.shape[-3:])
    print('mel:', tuple(mel.shape))
    notes_t, _ = model.transcribeFrames(fb)
    # ONNX 路径
    S_o, Ss_o = s_sess.run(None, {'mel': mel.numpy()})
    T = S_o.shape[0]
    paths, vicious = [], []
    s = torch.tensor(S_o)
    n = torch.tensor(Ss_o)
    for sym in range(90):
        sb = NeuralSemiCRFInterval(s[:, :, sym:sym + 1], n[:, sym:sym + 1])
        paths.append(sb.decode(forward=False)[0])
    # 属性头（torch 跑，和转录一致；attr onnx 已单独验过 1e-5）
    ctx = model.backbone(mel, outputIndices=torch.tensor(model.targetMIDIPitch))
    iv = [[p for p in paths[sy]] for sy in range(90)]
    nIv = sum(len(p) for p in iv)
    print('onnx intervals count:', nIv, 'Smax:', float(S_o.max()), 'Ssmax:', float(Ss_o.max()))
    ctx_a, ctx_b = None, None
    if nIv:
        ctx_a, ctx_b, _, _ = model.fetchIntervalFeaturesBatch(ctx, [iv])
    if ctx_a is not None and ctx_a.shape[0]:
        ai = torch.cat([ctx_a, ctx_b, ctx_a * ctx_b], -1)
        vel = torch.argmax(_F.softmax(model.velocityPredictor(ai), -1), -1).tolist()
    else:
        vel = []
    nt = sorted([(round(p.start, 3), round(p.end, 3), p.pitch, p.velocity) for p in notes_t[0]])
    print('torch notes:', len(nt), nt[:8])
    print('onnx intervals:', sum(len(p) for p in paths),
          sorted([(round(b * 1024 / 44100, 3), round(e * 1024 / 44100, 3), model.targetMIDIPitch[sy]) for sy in range(90) for (b, e) in paths[sy]])[:8])
    print('onnx velocities:', vel[:8])
    ta = {(p.pitch, round(p.start, 2)): p.velocity for p in notes_t[0] if p.pitch > 0}
    oa = {}
    vi = 0
    for sy in range(90):
        for (b, e) in paths[sy]:
            oa[(model.targetMIDIPitch[sy], round(b * 1024 / 44100, 2))] = vel[vi] if vi < len(vel) else None
            vi += 1
    match = sum(1 for k, v in oa.items() if k in ta and ta[k] == v)
    print('ALIGN: torch=%d onnx=%d exactMatch=%d' % (len(ta), len(oa), match))
    for k in sorted(set(ta) | set(oa)):
        if ta.get(k) != oa.get(k):
            print('VEL-DIFF', k, 'torch=%s onnx=%s' % (ta.get(k), oa.get(k)))
    print('torchKeys:', sorted(ta)[:12])
    print('onnxKeys:', sorted(oa)[:12])
