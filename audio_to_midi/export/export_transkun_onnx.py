#!/usr/bin/env python3
"""Transkun V2 -> ONNX 导出（阶段1，在 NVIDIA 台式机上运行）。

导出策略（已定，不导出整模型）：
  * 图1 scoring.onnx：输入=增益归一化后的波形帧 [1,1,F,4096]（与网站 worker.js 的
    makeFrames+gain归一输出完全对应），内含 MelSpectrum（含 nExtraWins=5 可学习
    高斯窗——这是权重的一部分，不能留在 JS 里）+ Backbone + InnerProductScorer。
    输出：S [T,T,S=90]（interval scores）、S_skip [T,S]、ctx（供属性头用）。
    F 固定 690（16s 段：ceil(16*44100/1024)+1，转写时不足补齐，见 transcribe()）。
  * 图2 heads.onnx：输入=区间属性向量 [N,480]（JS 照抄 fetchIntervalFeaturesBatch
    的 gather 语义拼出来），输出 velocity_logits [N,128] + of [N,4]
   （ofValue/ofPresence 各 2 维）。
  * 不导出：Semi-CRF Viterbi（C++ 扩展，无 ONNX 等价物）→ 阶段2 在 JS 手写；
    decode 后的 merge/resolve 后处理已在 worker 侧预留。

权重来源：pip 包 transkun 自带的 V2 No Pedal Ext（由 V2 Aug 微调），或 --weight
指定 .pt（checkpoint 含 state_dict / best_state_dict 双键，strict=False 载入）。

用法：
  pip install -r requirements-export.txt
  python export_transkun_onnx.py --out ./onnx_out
  python export_transkun_onnx.py --out ./onnx_out --weight /path/to/v2.pt --fp16
"""
import argparse, os, sys
import torch

SEG_SEC = 16
FS = 44100
HOP = 1024
WIN = 4096
NFRAMES = (SEG_SEC * FS + HOP - 1) // HOP + 1   # 16s -> 690
NSYM = 90                                        # [-64,-67] + 21..108


def load_model(weight=None, repo=None):
    if repo:
        sys.path.insert(0, repo)
    try:
        from transkun.ModelTransformer import TransKun, ModelConfig
    except ImportError:
        from ModelTransformer import TransKun, ModelConfig  # 直接用仓库源码
    conf = ModelConfig()  # 默认即 V2 配置
    model = TransKun(conf=conf)
    if weight:
        ckpt = torch.load(weight, map_location="cpu")
        key = "best_state_dict" if "best_state_dict" in ckpt else "state_dict"
        model.load_state_dict(ckpt[key], strict=False)
        print(f"[export] 载入权重 {weight}（键={key}）")
    else:
        # pip 包自带权重：按 transkun CLI 的权重定位逻辑找（找不到则报错提示 --weight）
        found = find_packaged_weight()
        ckpt = torch.load(found, map_location="cpu")
        key = "best_state_dict" if "best_state_dict" in ckpt else "state_dict"
        model.load_state_dict(ckpt[key], strict=False)
        print(f"[export] 载入 pip 自带权重 {found}（键={key}）")
    model.eval()
    n_params = sum(p.numel() for p in model.parameters())
    print(f"[export] 参数量：{n_params/1e6:.1f}M")
    return model


def find_packaged_weight():
    import transkun, glob
    base = os.path.dirname(transkun.__file__)
    cands = glob.glob(os.path.join(base, "**", "*.pt"), recursive=True)
    if not cands:
        raise SystemExit("[export] pip 包内未找到 .pt，请用 --weight 指定（见 README 明天手册）")
    # 优先 V2 / No Pedal Ext
    cands.sort(key=lambda p: ("v2" not in p.lower(), "pedal" in p.lower() and "no" not in p.lower()))
    print(f"[export] 包内候选权重：{cands}")
    return cands[0]


class ScoringWrapper(torch.nn.Module):
    """processFramesBatch 的前半（到 scorer 为止），输入已归一化的帧。"""
    def __init__(self, model):
        super().__init__()
        self.m = model

    def forward(self, framesBatch):
        m = self.m
        feats = m.framewiseFeatureExtractor(framesBatch).contiguous()
        nBatch = framesBatch.shape[0]
        feats = feats.view(nBatch, *feats.shape[-3:])
        ctx = m.backbone(feats, outputIndices=torch.tensor(m.targetMIDIPitch))
        S, S_skip = m.scorer(ctx)          # [T,T,B,S] / [T,B,S]
        S = S.flatten(-2, -1).squeeze(2)   # [T,T,B*S] -> 取 B=1
        S_skip = S_skip.flatten(-2, -1).squeeze(1)
        return S[:, :, :NSYM], S_skip[:, :NSYM], ctx


class HeadsWrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.m = model

    def forward(self, attributeInput):
        v = self.m.velocityPredictor(attributeInput)
        of = self.m.refinedOFPredictor(attributeInput)
        return v, of


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="./onnx_out")
    ap.add_argument("--weight", default=None)
    ap.add_argument("--repo", default=None, help="Transkun 源码目录（pip 包结构对不上时用）")
    ap.add_argument("--fp16", action="store_true", help="额外导出 fp16 版（精度对比见 validate）")
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    torch.set_grad_enabled(False)
    model = load_model(args.weight, args.repo)

    # ---- 探针：打一遍形状，确认导出契约 ----
    dummy = torch.randn(1, 1, NFRAMES, WIN)
    with torch.no_grad():
        S, S_skip, ctx = ScoringWrapper(model)(dummy)
    print(f"[export] scoring 输出形状：S={tuple(S.shape)} S_skip={tuple(S_skip.shape)} ctx={tuple(ctx.shape)}")
    T = S.shape[0]
    assert S.shape == (T, T, NSYM), S.shape

    # ---- 图1 ----
    p1 = os.path.join(args.out, "transkun-v2-scoring.onnx")
    torch.onnx.export(
        ScoringWrapper(model), dummy, p1,
        input_names=["frames"], output_names=["S", "S_skip", "ctx"],
        dynamic_axes={} if T == NFRAMES else None,
        opset_version=args.opset, do_constant_folding=True,
        dynamo=False)
    print(f"[export] 写出 {p1}（{os.path.getsize(p1)/1048576:.1f} MB）")

    # ---- 图2（N 动态：区间条数随乐曲变） ----
    attr_dim = model.velocityPredictor[0].in_features
    print(f"[export] 属性向量维度：{attr_dim}（期望 480=40*3*4）")
    dummy_h = torch.randn(8, attr_dim)
    p2 = os.path.join(args.out, "transkun-v2-heads.onnx")
    torch.onnx.export(
        HeadsWrapper(model), dummy_h, p2,
        input_names=["attr"], output_names=["velocity_logits", "of"],
        dynamic_axes={"attr": {0: "n_intervals"},
                      "velocity_logits": {0: "n_intervals"}, "of": {0: "n_intervals"}},
        opset_version=args.opset, do_constant_folding=True,
        dynamo=False)
    print(f"[export] 写出 {p2}（{os.path.getsize(p2)/1048576:.1f} MB）")

    if args.fp16:
        try:
            from onnxconverter_common import float16
            import onnx
            for src, tag in ((p1, "scoring"), (p2, "heads")):
                m = onnx.load(src)
                m16 = float16.convert_float_to_float16(m, keep_io_types=True)
                dst = os.path.join(args.out, f"transkun-v2-{tag}.fp16.onnx")
                onnx.save(m16, dst)
                print(f"[export] 写出 {dst}（{os.path.getsize(dst)/1048576:.1f} MB）")
        except ImportError:
            print("[export] 缺 onnxconverter_common，跳过 fp16（pip install onnxconverter-common 后重跑 --fp16）")

    print("[export] 完成。下一步：python validate_onnx.py --onnx", args.out, "--sample <MAESTRO wav>")


if __name__ == "__main__":
    main()
