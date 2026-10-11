# 音频转 MIDI（浏览器本地钢琴转写）

打开网页、传一段钢琴录音，浏览器里直接算出 MIDI，全程不需要服务器 GPU 和 Python。
对标开源项目 Transkun（Transformer + Neural Semi-CRF，V2），在线入口是门户 `音频转 MIDI` 卡片。

## 整体分四步走

**先搭框架。** 延续本站风格用的原生 JS（没上 React/Vite），`index.html` 管上传、录音和进度展示，
`app.js` 管解码、模型缓存和 Worker 调度，`worker.js` 管特征、推理和 MIDI 生成。框架阶段先用合成音阶自检
把"特征→MIDI→预览→下载"整条链跑通，确认链路本身没问题，再请模型入场——自检按钮使命完成后已删除。

**再导权重。** 这是最绕的一段。Transkun V2 是全自定义架构，整模型根本导不进 ONNX，
于是只导评分网络，Viterbi 解码在 `viterbi.js` 里手写（好在它的 CRF 是纯 torch、没有 C++，
可以逐行移植）。导出的两个文件（评分 57MB + 属性头 3.4MB）放在 Cloudflare R2，
页面进场就后台预下载，OPFS 缓存 + 字节校验 + 双镜像竞速，第二次打开秒开。

**然后对齐。** 模型吃的是 log-mel，不是波形，浏览器端必须和 Python 端算得一模一样，
差一点输入分布就偏了。于是把特征契约逐行抄过来：44.1kHz 单声道、4096 窗/1024 跳、229 维 mel、
torchaudio `norm=None`（一开始假设成 slaney，差了 0.98，被 checkpoint 自带的滤波器 bank 纠正回来）、
6 通道 STFT（hann + 5 个全精度高斯窗）、每 16 秒段独立归一。分段、步进、起止帧、
Viterbi 取分方向、力度 argmax、offset 公式，全部和 torch 源码对齐，有一条对不上的都不放过。

**最后产品化。** 延音展开、多音色输出、WebGPU 并行、转写一键送进重制版播放，见下文。

## 几个关键决策

- **WebGPU 用 fp16 权重。** 评分张量 `691×691×90` 单张 171MB，手机 GPU 直接 device lost。
  手机现导 fp16（29MB），位置全对、力度差 ±2（人耳不可闻），WASM 路径继续用 fp32 保满血。
- **失败就换路。** WebGPU 建会话或跑挂了，整体回 wasm 重跑；崩溃挂在 ort 内部游离 promise 上
  （try/catch 天生抓不到）就经 `gpuLost` 消息重跑。张量用完立刻 `dispose()`。
- **训练语义照单全收。** 原生 `transcribe()` 输出的是按键时长，听着短是因为少了延音展开——
  而训练数据预处理里是有 `extendPedal` 的（键松了但踏板踩着，音延到踏板抬起）。移植过来默认打开，
  踏板 CC 照样写入文件，两边都不丢。
- **多乐器是分区配器。** 下拉可选"仅钢琴"或"多乐器"（<48 大提琴 / 48–71 钢琴 / ≥72 小提琴，
  踏板 CC 发到所有在用通道）。文件本身是标准多通道 MIDI；重制版预览目前只读 ch0，
  要按通道试听得动发声主干，另立项。

## 踩过的坑（都是实测撞出来的）

- onnxruntime-web 1.22 改名，旧路径双 CDN 404 整页失败：换 `ort.all.min.js` + 双镜像回退 + 进页 warmup。
- wasm/`.mjs` 相对 worker 地址 404 到本站：`wasmPaths` 指回 CDN；多线程 wasm 要 SAB，
  给本目录加 COOP/COEP（只圈本目录，不碰别页）。
- 会话创建 + 推理黑盒几分钟零反馈：拆成会话/打分/Viterbi 心跳/属性头的分段上报，进度条全程可见。
- `Worker 错误：undefined` 没法定位：`unhandledrejection` 上报 + onerror 全字段 + 错误桥接进页日志，
  加载期暴毙也留字条。
- Viterbi 取数长度 bug，Python 自测 30 轮没发现，JS 对拍抓到；CB 均值差 0.058，
  根因是 torch 内部偷偷 clamp 了 probs；高斯窗 4 位小数引入 2.5e-4 误差，换全精度。
- 两次 `?v=` 漏 bump 让用户跑到旧代码：现部署工作流按文件内容哈希自动重写 `?v=`（`deploy.yml`：`git hash-object … | cut -c1-7` 取 app/worker 短哈希分别 sed 进 `index.html`/`app.js`），没改代码就不 bust 缓存，人不用记；版本自报行运行时回读（app 读 script src，worker 读 `self.location.search`）。

## 精度（实测数，不吹）

fp32 全链：真实权重驱动真实 `worker.js` 代码，对 torch 参考 **12/12 精确一致**；
gather 索引 diff 精确 0，mel 端到端 worst 7e-4。fp16：11/12 精确 + 1 个尾音差一帧 + 力度 ±2。
验证脚本都在 `export/`（`test_inferall_js.mjs`、`test_extend.mjs` 等），手机上直接能跑。

## 下一步

`.br` 压缩（scorer 省 10MB，待 app 接解压）；`crossOriginIsolated=否` 待用户清站缓存确认（不再动 header）；
int8 量化备选；实时麦克风流式转写；V2 按通道试听。
