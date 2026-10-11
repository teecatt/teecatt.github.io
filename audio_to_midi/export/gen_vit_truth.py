#!/usr/bin/env python3
"""用真实 torch CRF 生成 Viterbi 真值，供 node 侧 viterbi.js 对拍。"""
import sys, json, torch
sys.path.insert(0, '/tmp/opencode/transkun')
from transkun.CRF.NeuralSemiCRFInterval import NeuralSemiCRFInterval

torch.manual_seed(20261011)
cases = []
for T in (1, 2, 5, 17, 60):
    for trial in range(3):
        B = 2
        score = (torch.randn(T, T, B) * 3.0).tolist()
        noise = (torch.randn(max(T - 1, 1), B) * 2.0).tolist()
        ref = []
        with torch.no_grad():
            s = torch.tensor(score)
            n = torch.tensor(noise[:T - 1] if T > 1 else [[0.0] * B])
            for b in range(B):
                sb = NeuralSemiCRFInterval(s[:, :, b:b + 1], n[:, b:b + 1])
                fs = [0] if (T + trial) % 2 == 0 else [min(trial, T - 1)]
                try:
                    path = sb.decode(forcedStartPos=fs, forward=False)[0]
                    ps = float(sb.evalPath([path]).item())
                except RuntimeError:
                    path, ps = None, None
                ref.append({'path': ([list(p) for p in path] if path is not None else None), 'score': ps, 'fs': fs[0]})
        cases.append({'T': T, 'score': score, 'noise': noise, 'ref': ref})
json.dump(cases, open('/tmp/opencode/vit_truth.json', 'w'))
print('cases:', len(cases))
