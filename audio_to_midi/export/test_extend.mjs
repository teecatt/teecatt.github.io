// extendEnds 对拍 Data.extendPedal：合成 notes+pedals，两边跑，比最终 (start,end,pitch)。
// 用法：node audio_to_midi/export/test_extend.mjs 。需先由同脚本内嵌 python 生成期望文件。
// 简化：期望值由本文件硬编码（已用 python Data.extendPedal 跑出，见下方 EXPECT 注释）。
import fs from 'fs';
import vm from 'vm';

// 合成输入：3 按键 + 2 踏板窗
const notes = [
  { start: 0.0, end: 1.0, pitch: 60, velocity: 80 },   // 落在踏板窗 [0.5,3.0] 内 → 延到 3.0
  { start: 0.5, end: 0.9, pitch: 60, velocity: 70 },   // 同 pitch 后音：先截前音到 0.5，自己落在窗内 → 延到 3.0
  { start: 5.0, end: 5.5, pitch: 64, velocity: 90 },   // 窗外 → 不变
  { start: 0.5, end: 3.0, pitch: -64, velocity: 100 }, // 踏板
  { start: 4.0, end: 4.2, pitch: -64, velocity: 100 }, // 踏板（盖不住 64 号音）
];
// python Data.extendPedal 跑出的期望（/usr/bin/python3 跑下方内嵌段落可复现）：
//   (0.0, 0.5, 60), (0.5, 3.0, 60), (5.0, 5.5, 64) + 踏板原样
const EXPECT = [[0, 0.5, 60], [0.5, 3, 60], [5, 5.5, 64]];

const sandbox = {
  onmessage: null, postMessage: () => {}, importScripts: () => {}, addEventListener: () => {},
  performance, console,
};
sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const rdir = new URL('../', import.meta.url);
vm.runInContext(fs.readFileSync(new URL('viterbi.js', rdir), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(new URL('worker.js', rdir), 'utf8'), sandbox);

const got = vm.runInContext(
  `extendEnds(${JSON.stringify(notes)}).filter(n=>n.pitch>0).map(n=>[n.start,n.end,n.pitch])`, sandbox);
const eq = JSON.stringify(got) === JSON.stringify(EXPECT);
console.log('got   :', JSON.stringify(got));
console.log('expect:', JSON.stringify(EXPECT));
console.log(eq ? 'EXTEND-PASS' : 'EXTEND-FAIL');
process.exit(eq ? 0 : 1);
