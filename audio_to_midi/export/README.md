# Transkun V2 → ONNX（阶段1：已在手机端完成 ✅，台式机备用）

2026-10-11 实录：本机（Ubuntu 用户态 + python3.14 + torch 2.10.0+cpu）已跑通导出，
**不再需要 CUDA、不再需要等台式机**。权重是仓库自带的 `pretrained/2.0.pt`（56MB），零额外流量。

## 产物（`/tmp/opencode/onnx_out/`，未进 git——见下）

| 文件 | 大小 | 接口 |
|---|---|---|
| `transkun_scorer.onnx` | 57MB | mel `[1,691,229,6]` → `S[691,691,90]`、`Sskip[690,90]` |
| `transkun_attr.onnx` | 3.4MB | `ctx_a[N,256]`、`ctx_b[N,256]` → `vLogits[N,128]`、`ofRaw[N,4]` |
| `gauss_windows.json` | 239B | 5 组高斯窗 sigma/center（已进 git，本目录） |

合计约 60MB，无需量化。下一步：传 HuggingFace，拿直链填 `app.js` 的 `MODEL_HF_URL`。

## 本目录文件

- `export_transkun_onnx.py`：导出脚本（用法：`python3 export_transkun_onnx.py --repo /path/to/Transkun --out ./onnx_out`）
- `validate_onnx.py`：数值校验（`TRANSKUN_REPO`/`TRANSKUN_ONNX_OUT` 环境变量可改路径）
- `test_e2e_synth.py`：合成功能验证（双音旋律 → torch vs ONNX 音符对比）
- `viterbi_ref.py` + `test_viterbi.mjs` + `gen_vit_truth.py` + `test_viterbi_diff.js`：Viterbi 移植与真值对拍
- `test_worker_viterbi.mjs`：worker 内自检
- `gauss_windows.json`：高斯窗参数（worker 6 通道 STFT 用）
- `requirements-export.txt`：环境（已过时，实际用的是 torch 2.10+cpu，见下）

## 验证结论（都过了）

- Viterbi：torch 真值 15 组 case，路径 24/24 全对，分数差 ≤1.6e-5（float32 舍入）；T=1 时 torch 原版崩溃，JS 版鲁棒返回。
- ONNX 数值：attr 头 1e-5；scorer 绝对差 2.9——**不是 bug**：S 量级 ~63000（内积×|e-b| 放大），相对误差 4.6e-5，纯累积舍入（backbone 分段抽头定位：t1 6e-5 → t3 9e-4 → ctx 2.6e-3，逐层温和放大，无跳变点）。
- 功能：合成旋律 12/12 音符一致（pitch 全对、力度全对、起始时间最大差 1 帧 23ms）。

## 手机导出关键经验（重跑时看）

1. `pip install torch` 在 Termux python（android tag）无轮子；本机 `/usr/bin/python3.14`（linux-aarch64）有官方 `manylinux_2_28_aarch64` CPU 轮子：`--index-url https://download.pytorch.org/whl/cpu torch==2.10.0+cpu torchaudio==2.10.0+cpu`（配对版本）。
2. `transkun` 包 `from . import CRF` 会触发 torch 2.10 的 `@torch.jit.script` 编译失败——导出根本不需要 CRF，用 `sys.modules` 注入 stub 绕过（脚本里已有）。
3. 导出三处 monkeypatch（只影响导出进程）：SDPA 数学等价实现、checkpoint 旁路、`diag_embed` 等价改写（`d.unsqueeze(-1)*eye`）。
4. **T=691 不是 690**：`nFrame=ceil(705600/1024)+1=691`，`lastFrameIdx=689`。ONNX 已定形 691，worker 分段必须产 691 帧。
5. classic exporter（dynamo=False）产单文件；dynamo 版拆出 `.data` 外置权重，浏览器端麻烦——用 classic 版。
6. 校验阈值要用**相对误差**（S 量级 6e4），绝对 1e-4 必然误报。

## 排错对照表

| 现象 | 原因 / 做法 |
|---|---|
| `No module named 'torch'` | 用 `/usr/bin/python3`（不是 `python3`），或重装 CPU 轮子（见经验1） |
| `@torch.jit.script` 处 `RuntimeError` | CRF 导入问题，确认 stub 代码还在（`sys.modules.setdefault('transkun.CRF', …)`） |
| `aten::xxx not supported` | 看脚本内 monkeypatch 是否覆盖了该算子；dynamo/classic 换着试 |
| S 输出 T 不是 691 | 段长被改过（检查 conf.segmentSizeInSecond），把实际 T 告诉我，同步改 worker |
| validate 绝对差 ~2.9 | 正常（相对 4.6e-5），跑 `test_e2e_synth.py` 看功能一致性 |

## 之后（阶段2）

worker 侧待办：6 通道 STFT（hann＋5 高斯窗，参数见 `gauss_windows.json`，公式 `exp(-0.5*((x-4096*c)/(s*4096/2))²)`)
→ mel `[691,229,6]` → `ort.web` 跑 scorer → `viterbi.js` 解码（已验证）→ attr onnx → velocity 取 argmax、offset 用 ContinuousBernoulli 均值公式（见 `transcribeFrames` 源码行 640-650）。
权重直链一到（HF），转写页切掉自检模式即成真转写。
