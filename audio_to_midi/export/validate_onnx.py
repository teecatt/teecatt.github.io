#!/usr/bin/env python3
"""ONNX 数值校验：onnxruntime vs torch（scorer + attr），过才算导出成功。"""
import sys, os, numpy as np, torch
sys.path.insert(0, os.environ.get('TRANSKUN_REPO', '/tmp/opencode/transkun'))
import moduleconf
from transkun.ModelTransformer import TransKun
from export_onnx import ScorerNet, AttrNet

OUT = os.environ.get('TRANSKUN_ONNX_OUT', '/tmp/opencode/onnx_out')
torch.manual_seed(11)
conf = moduleconf.parseFromFile('/tmp/opencode/transkun/transkun/pretrained/2.0.conf')['Model'].config
model = TransKun(conf=conf)
ckpt = torch.load('/tmp/opencode/transkun/transkun/pretrained/2.0.pt', map_location='cpu')
model.load_state_dict(ckpt['best_state_dict' if 'best_state_dict' in ckpt else 'state_dict'], strict=False)
model.eval()

import onnxruntime as ort
so = ort.SessionOptions()
so.intra_op_num_threads = 4
s_sess = ort.InferenceSession(os.path.join(OUT, 'transkun_scorer.onnx'), so, providers=['CPUExecutionProvider'])
a_sess = ort.InferenceSession(os.path.join(OUT, 'transkun_attr.onnx'), so, providers=['CPUExecutionProvider'])

with torch.no_grad():
    mel = torch.randn(1, 690, 229, 6)  # 与导出定形一致
    S_t, Ss_t = ScorerNet(model)(mel)
    S_o, Ss_o = s_sess.run(None, {'mel': mel.numpy()})
    dS = float(np.abs(S_t.numpy() - S_o).max())
    dSs = float(np.abs(Ss_t.numpy() - Ss_o).max())
    print('scorer: S shape', S_o.shape, 'Sskip', Ss_o.shape, 'maxDiff S=%.3g Sskip=%.3g' % (dS, dSs))
    a = torch.randn(6, 256)
    v_t, o_t = AttrNet(model)(a, a)
    v_o, o_o = a_sess.run(None, {'ctx_a': a.numpy(), 'ctx_b': a.numpy()})
    dv = float(np.abs(v_t.numpy() - v_o).max())
    do = float(np.abs(o_t.numpy() - o_o).max())
    print('attr: vLogits', v_o.shape, 'ofRaw', o_o.shape, 'maxDiff v=%.3g of=%.3g' % (dv, do))
    ok = dS < 1e-4 and dSs < 1e-4 and dv < 1e-4 and do < 1e-4
    print('VALIDATE-' + ('OK' if ok else 'FAIL'))
    sys.exit(0 if ok else 1)
