# Transkun V2 → ONNX（阶段1：明天在 NVIDIA 台式机上跑）

本目录 3 个文件：`requirements-export.txt`（环境）、`export_transkun_onnx.py`（导出）、
`validate_onnx.py`（三层校验）。网站本身不受影响（纯新增目录）。

## 明天操作手册（预计 20–40 分钟）

```powershell
# 1) 建环境（需要 Python 3.10+，NVIDIA 显卡装 CUDA 版 onnxruntime）
pip install -r requirements-export.txt

# 2) 导出（自动用 pip 包自带的 V2 No Pedal Ext 权重；约 2–5 分钟）
python export_transkun_onnx.py --out ./onnx_out
# 预期输出：
#   [export] 参数量：约 XX M
#   [export] scoring 输出形状：S=(690, 690, 90) ...
#   [export] 写出 transkun-v2-scoring.onnx（约 XXX MB）
#   [export] 写出 transkun-v2-heads.onnx（很小，<5MB）
#   [export] 属性向量维度：480（期望 480=40*3*4）
```

```powershell
# 3) 校验（准备一段 MAESTRO 钢琴 wav，≥16s；约 3–8 分钟，首次含 CUDA 预热）
python validate_onnx.py --onnx ./onnx_out --sample D:\data\maestro_sample.wav
# 预期：层1 max|ΔS|<1e-4 PASS / 层2 90/90 全等 PASS / 层3 PASS
```

```powershell
# 4) 文件大（scoring 超 100MB）就加 --fp16 再导一遍，并用 --fp16 校验
#   （fp16 期望：层1 <1e-2，层3 F1 ≥0.97）
python export_transkun_onnx.py --out ./onnx_out --fp16
python validate_onnx.py --onnx ./onnx_out --sample D:\data\maestro_sample.wav --fp16
```

```powershell
# 5) 传 HuggingFace（建个公开仓库，如 <你的用户名>/transkun-v2-onnx）
huggingface-cli upload <你的用户名>/transkun-v2-onnx ./onnx_out --repo-type model
```

```text
# 6) 把直链发我（或自己填，两处保持一致）：
#    audio_to_midi/app.js  的 MODEL_HF_URL
#    audio_to_midi/worker.js 的 ORT_MODEL_URL
# 格式：https://huggingface.co/<用户>/transkun-v2-onnx/resolve/main/transkun-v2-scoring.onnx
# heads 很小，可一起传（worker 按需再接）。
```

## 排错对照表

| 现象 | 原因 / 做法 |
|---|---|
| `pip 包内未找到 .pt` | transkun 新版改了权重分发，用 `--weight` 直接指 .pt（Google Drive 下的 V2 / V2 Aug 均可，先用 No Pedal Ext） |
| `from transkun.ModelTransformer import` 失败 | transkun 包结构与 GitHub 不一致，加 `--repo D:\Transkun` 指源码目录 |
| 导出报 `torch.fft.rfft` 不支持 | 降 `--opset 18` 重试；仍不行把完整报错贴我，切 dynamo 导出 |
| scoring 输出 T 不是 690 | 段长被改过（检查 conf.segmentSizeInSecond），把实际 T 告诉我，我同步改 worker 分段 |
| 属性维度不是 480 | 同上，贴出实际数字 |
| validate 层2不一致 | 分数差超阈值才会发生，先看层1数字；fp16 允许个别符号翻转，看层3 F1 |
| 显存不足 | 导出/校验全程 batch=1，690 帧约需 <4GB；仍爆则关其他程序，CPU 也能跑（慢 5–10 倍） |

## 之后我来接（阶段2，不用你管）

Viterbi 在 JS 手写（`worker.js` 已留 `runModel` 钩子，含段合并语义说明），
接 `ort.web.min.js`（WebGPU 优先/WASM 回退），OPFS 缓存与进度链路已就绪。
权重直链一到，转写页切掉自检模式即成真转写。
