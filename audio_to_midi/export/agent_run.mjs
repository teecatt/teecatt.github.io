// agent 无页面调试入口：Node 直跑真实管线（mel→打分→Viterbi→MIDI），不依赖浏览器/DOM。
// 用法：node agent_run.mjs --pcm /tmp/seg.pcm --sr 44100 [--segments N] [--out /tmp/out.mid] [--models ./models] [--json /tmp/timing.json]
// 输入 PCM 为 Float32LE 裸文件（外部解码准备，本脚本不解 mp3）；退出码 0=成功，2=用法/环境问题。
//
// 管线来源（仿 test_inferall_js.mjs 沙箱思路）：vm 整份加载 ../worker.js + viterbi.js 原文，
// 先做锚点存在性校验（worker 改名/删函数即 fail-fast），实际调用的真实函数：
//   inferAll（全量分段推理主入口）/ framesToMel6（6通道log-mel，包一层计 mel 每段耗时）/
//   makeFrames / gainNorm / resample（sr!=44100 时）/ writeMidi（SMF 写入）/
//   buildMelBank+MEL_BANK+MEL_RANGE / fft+HANN+GAUSS_WINS（特征底层）/
//   extendEnds+resolveOverlapping+symToPitch（后处理，inferAll 内部调用）/
//   TranskunViterbi.decode（viterbi.js，inferAll 内部调用）。
// ONNX 会话由 onnxruntime-node 建 CPU 会话（缺失即报错提示安装，绝不自动安装）。
// 跨 realm 注意：传给 inferAll 的是包了 Tensor 的 ortForSandbox（沙箱数组→主域拷贝，见下）。
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let ort;
try {
  ort = require('onnxruntime-node');
} catch {
  console.error("缺少 onnxruntime-node：请先在 export 目录执行 `npm i onnxruntime-node`（不自动安装）");
  process.exit(2);
}

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const pcmPath = opt('pcm'), sr = Number(opt('sr', '44100'));
const segLimit = Number(opt('segments', '0')) || 0;
const modelsDir = opt('models', path.join(path.dirname(new URL(import.meta.url).pathname), 'models'));
const outMid = opt('out', pcmPath ? pcmPath + '.mid' : 'out.mid');
const outJson = opt('json', '');
const outMode = opt('outMode', 'piano');
if (!pcmPath || !fs.existsSync(pcmPath) || !(sr > 0)) {
  console.error('用法：node agent_run.mjs --pcm raw文件 --sr 44100 [--segments N] [--out out.mid] [--models dir]');
  process.exit(2);
}

// ---- 沙箱加载真实管线 ----
const base = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, base), 'utf8');
const workerSrc = read('worker.js'), vitSrc = read('viterbi.js');
const anchors = ['async function inferAll(', 'function framesToMel6(', 'function makeFrames(',
  'function gainNorm(', 'function resample(', 'function writeMidi(', 'function buildMelBank(',
  'const MEL_RANGE', 'function fft(', 'const HANN', 'TranskunViterbi'];
for (const a of anchors) {
  if (!workerSrc.includes(a) && !vitSrc.includes(a)) {
    console.error(`锚点失效（worker.js/viterbi.js 已变更）：${a}`);
    process.exit(2);
  }
}
const posted = [];
const sandbox = {
  onmessage: null,
  postMessage: (m) => posted.push(m),
  importScripts: () => {},
  addEventListener: () => {},
  performance, console, setTimeout, clearTimeout,
  navigator: {}, self: null, globalThis: null,
};
sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(vitSrc, sandbox);
vm.runInContext(workerSrc, sandbox);

// ---- 输入 PCM（Float32LE 裸文件；--segments N 只取覆盖前 N 段的采样） ----
const raw = fs.readFileSync(pcmPath);
const cp = Buffer.alloc(raw.length); raw.copy(cp);
let pcm = new Float32Array(cp.buffer, 0, cp.length / 4);
if (segLimit > 0) {
  const need = (segLimit - 1) * 352800 + 705600; // 8s步/16s段 @44100
  if (pcm.length > need) pcm = pcm.slice(0, need);
}
if (sr !== 44100) pcm = sandbox.resample(pcm, sr, 44100);

// ---- CPU 会话 + 计时包装（打分每段 / attr 每段） ----
const msScorePerCall = [], msAttrPerCall = [];
// 跨 realm 修补：vm 沙箱内的 TypedArray/Array 与主域不是同一个类，
// onnxruntime-node 建 Tensor 时做 instanceof 校验会拒收沙箱数组
// （TypeError: A float32 tensor's data must be type of Float32Array）。
// 故凡进 Tensor 的数据/dims 一律在主域侧拷贝一道（数值/形状不变）。
function toMainRealm(data) {
  if (ArrayBuffer.isView(data)) {
    const name = data.constructor && data.constructor.name;
    if (name === 'Float32Array') return Float32Array.from(data);
    if (name === 'Uint8Array') return Uint8Array.from(data);
    if (name === 'Int32Array') return Int32Array.from(data);
    if (name === 'Float64Array') return Float64Array.from(data);
    if (name === 'BigInt64Array') return BigInt64Array.from(data);
    const Ctor = globalThis[name];
    if (typeof Ctor === 'function') return Ctor.from(data);
  }
  return data;
}
// 须是普通 function（可被 new 调用；返回对象即覆盖 this）：把沙箱数组转主域后再建真 Tensor。
function OrtTensor(type, data, dims) {
  return new ort.Tensor(type, toMainRealm(data), Array.isArray(dims) ? Array.from(dims) : dims);
}
const ortForSandbox = { ...ort, Tensor: OrtTensor };
const scorerSession = await ort.InferenceSession.create(path.join(modelsDir, 'transkun_scorer.onnx'));
const attrSession = await ort.InferenceSession.create(path.join(modelsDir, 'transkun_attr.onnx'));
const scorer = {
  run: async (feeds) => {
    const t = performance.now();
    try { return await scorerSession.run(feeds); } finally { msScorePerCall.push(performance.now() - t); }
  },
};
const attr = {
  run: async (feeds) => {
    const t = performance.now();
    try { return await attrSession.run(feeds); } finally { msAttrPerCall.push(performance.now() - t); }
  },
};
// mel 每段计时：inferAll 内部调全局 framesToMel6，包一层即全量 instrument（不改 worker 逻辑）
const msMelPerSeg = [];
const origMel6 = sandbox.framesToMel6;
sandbox.framesToMel6 = (...a) => {
  const t = performance.now();
  try { return origMel6(...a); } finally { msMelPerSeg.push(performance.now() - t); }
};

// ---- 真实 inferAll + 写 MIDI ----
const t0 = performance.now();
const r = await sandbox.inferAll(ortForSandbox, [scorer], attr, 'cpu', pcm, { extend: true });
const msTotal = performance.now() - t0;
const midiBytes = Buffer.from(sandbox.writeMidi(r.notes, outMode));
fs.writeFileSync(outMid, midiBytes);
const timing = {
  backend: 'cpu(onnxruntime-node)', sr, segments: segLimit || 'all',
  notes: r.notes.length, msTotal: Math.round(msTotal),
  msMelPerSeg: msMelPerSeg.map(Math.round), msScorePerCall: msScorePerCall.map(Math.round),
  msAttrPerCall: msAttrPerCall.map(Math.round), midi: outMid,
};
console.log(JSON.stringify(timing));
if (outJson) fs.writeFileSync(outJson, JSON.stringify(timing, null, 2));
