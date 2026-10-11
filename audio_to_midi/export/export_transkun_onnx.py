#!/usr/bin/env python3
"""Transkun 评分网络导出为 ONNX（手机 CPU 可跑）。

只导出推理必需的两块（CRF/Viterbi、velocity/of 后处理留给 JS）：
  A. transkun_scorer.onnx：mel 特征 [1,T,229,6] → S[T,T,90], Sskip[T-1,90]
  B. transkun_attr.onnx：ctx_a[N,256], ctx_b[N,256] → vLogits[N,128], ofRaw[N,4]
另存：gauss_windows.json（5 组高斯窗 sigma/center，JS 端 6 通道 STFT 用）。

用法：
  python3 export_transkun_onnx.py --repo /tmp/opencode/transkun --out ./onnx_out
"""
import argparse, json, os, sys, torch
import math
import torch.nn.functional as _F

_orig_sdpa = _F.scaled_dot_product_attention


def _sdpa_math(q, k, v, attn_mask=None, dropout_p=0.0, is_causal=False, scale=None):
    d = q.shape[-1]
    s = 1.0 / math.sqrt(d) if scale is None else scale
    attn = (q @ k.transpose(-2, -1)) * s
    if is_causal:
        L, S = q.shape[-2], k.shape[-2]
        mask = torch.ones(L, S, dtype=torch.bool, device=q.device).tril()
        attn = attn.masked_fill(~mask, float('-inf'))
    if attn_mask is not None:
        attn = attn + attn_mask
    return torch.softmax(attn, dim=-1) @ v


_F.scaled_dot_product_attention = _sdpa_math

import torch.utils.checkpoint as _cp


def _ckpt_bypass(function, *args, **kwargs):
    kwargs.pop('use_reentrant', None)
    return function(*args)


_cp.checkpoint = _ckpt_bypass

import types as _types

_crf_stub = _types.ModuleType('transkun.CRF')


class _CRFStub:
    def __init__(self, *a, **k):
        raise RuntimeError('CRF stub: not on export path')


_crf_stub.NeuralSemiCRFInterval = _CRFStub
sys.modules.setdefault('transkun.CRF', _crf_stub)

_orig_diag_embed = torch.diag_embed


def _diag_embed_eq(d):
    # diag_embed([... T]) -> [... T T]，等价实现（ONNX 可导出）
    T = d.shape[-1]
    idx = torch.arange(T, device=d.device)
    eye = (idx.unsqueeze(0) == idx.unsqueeze(1)).to(d.dtype)
    return d.unsqueeze(-1) * eye


torch.diag_embed = _diag_embed_eq

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--repo', default='/tmp/opencode/transkun')
    p.add_argument('--out', default='/tmp/opencode/onnx_out')
    p.add_argument('--opset', type=int, default=18)
    return p.parse_args()


class ScorerNet(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.backbone = model.backbone
        self.scorer = model.scorer
        self.register_buffer('pitches', torch.tensor(model.targetMIDIPitch, dtype=torch.long))

    def forward(self, mel):
        ctx = self.backbone(mel, outputIndices=self.pitches)
        S, Ss = self.scorer(ctx)
        return S.squeeze(2), Ss.squeeze(1)


class AttrNet(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.vp = model.velocityPredictor
        self.ofp = model.refinedOFPredictor

    def forward(self, a, b):
        x = torch.cat([a, b, a * b], dim=-1)
        return self.vp(x), self.ofp(x)


def main():
    args = parse_args()
    sys.path.insert(0, args.repo)
    import moduleconf
    from transkun.ModelTransformer import TransKun
    os.makedirs(args.out, exist_ok=True)

    conf = moduleconf.parseFromFile(os.path.join(args.repo, 'transkun/pretrained/2.0.conf'))['Model'].config
    model = TransKun(conf=conf)
    ckpt = torch.load(os.path.join(args.repo, 'transkun/pretrained/2.0.pt'), map_location='cpu')
    key = 'best_state_dict' if 'best_state_dict' in ckpt else 'state_dict'
    model.load_state_dict(ckpt[key], strict=False)
    model.eval()

    torch.manual_seed(3)
    with torch.no_grad():
        mel = torch.randn(1, 691, 229, 6)  # 固定 T=691（ceil(705600/1024)+1），16s 段恒定帧数
        sn = ScorerNet(model)
        S, Ss = sn(mel)
        assert list(S.shape) == [691, 691, 90], S.shape
        assert list(Ss.shape) == [690, 90], Ss.shape
        torch.onnx.export(sn, (mel,), os.path.join(args.out, 'transkun_scorer.onnx'),
                          input_names=['mel'], output_names=['S', 'Sskip'],
                          dynamic_axes=None,
                          opset_version=args.opset, dynamo=False)
        D = S.shape[-1] and 256
        a = torch.randn(4, 256)
        an = AttrNet(model)
        v, o = an(a, a)
        assert list(v.shape) == [4, 128] and list(o.shape) == [4, 4]
        torch.onnx.export(an, (a, a), os.path.join(args.out, 'transkun_attr.onnx'),
                          input_names=['ctx_a', 'ctx_b'], output_names=['vLogits', 'ofRaw'],
                          dynamic_axes={'ctx_a': {0: 'N'}, 'ctx_b': {0: 'N'},
                                        'vLogits': {0: 'N'}, 'ofRaw': {0: 'N'}},
                          opset_version=args.opset, dynamo=False)
        spec = model.framewiseFeatureExtractor.spectrogramExtractor
        gw = {'nWin': spec.winGen.nWin,
              'sigma': torch.sigmoid(spec.winGen.sigma).tolist(),
              'center': torch.sigmoid(spec.winGen.center).tolist()}
        json.dump(gw, open(os.path.join(args.out, 'gauss_windows.json'), 'w'))
    for f in ('transkun_scorer.onnx', 'transkun_attr.onnx'):
        print(f, os.path.getsize(os.path.join(args.out, f)))
    print('gauss:', [round(x, 4) for x in gw['sigma']])
    print('EXPORT-OK')


if __name__ == '__main__':
    main()
