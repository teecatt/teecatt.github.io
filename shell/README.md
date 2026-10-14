# MWS — Multi-Window Shell（多窗口同步壳）

完全解耦的组件式外壳：把「同浏览器多窗口互认 → 自动编号 → 均分分片 → 双扫描线画布标定 → 业务状态跨窗联动」打包成一个可复用组件，套在**任意前端页面**（或混合页面的前端视图层）上。

## 接入（一行）

```html
<script src="../shell/shell.js"></script>
```

页面可选提供适配器（脚本前后皆可，壳会轮询拾取）：

```js
window.ShellAdapter = {
  getState()          { /* 返回业务状态快照，JSON 可克隆 */ },
  applyState(data)    { /* 收到他窗状态时应用；应用期间壳会抑制回声 */ },
  domain: { lo: 21, hi: 109, label: '键' },  // 可选：均分域（壳算分片）
  onAssign(a)         { /* {index,count,slice} 窗口编号/分片变化 */ },
  applyOffset(ms)     { /* 可选：显示偏移（物理显示延迟）补偿 */ },
};
```

无适配器时为**纯展示模式**：互认、编号、序号下拉、扫描线、标定、RTT 照常工作，只是不联动业务状态。

## 公开 API

```js
window.__MWS.notify()              // 业务状态已变化 → 广播（回声期间自动抑制）
window.__MWS.onAssign(cb)          // 订阅分片（立即回调一次当前值）
window.__MWS.assignment()          // 读当前 {index, count, slice}
window.__MWS.setOffset(ms)         // 设置显示偏移（持久化并转交 applyOffset）
```

## 协议（BroadcastChannel `mws.v1` + localStorage 兜底）

| 消息 | 方向 | 说明 |
|---|---|---|
| `hello` | 全员 800ms | 身份(打开时刻)、hidden、窗口宽高 |
| `state` | 全员 500ms | 壳状态 `sv` 版本化：序号覆写 `ord`、扫描轮 `sw` |
| `page` | #1 心跳 1s / 变更即时 | 适配器业务状态 `psv` 版本化中继 |
| `swdone` | 确认 | 本窗两条线走完当前轮 |
| `ping/pong` | 1s | RTT |

- **编号**：手动序号（下拉，占用自动对调）优先，其余按打开顺序补位；各窗独立计算，结果一致。
- **扫描线**：横线按窗口像素宽度加权 `#1→#N` 接力（像素速度均匀）；纵线每窗全高归一同相位下扫，周期一致；`#1` 收齐所有可见窗 `swdone`（4s 超时兜底）才生成下一根；窗口集合/尺寸变化立即重开。
- **显示延迟标定**：手机拍两窗读**大字钟**毫秒差 → 填「显示偏移」→ 转交 `applyOffset`。

## 目录

- `shell/shell.js` —— 本组件（单文件，Shadow DOM 样式隔离）
- `midi_multiwin/` —— MIDI播放器V2 + 本壳的参考接入（`adapter.js` 为页面适配器）
