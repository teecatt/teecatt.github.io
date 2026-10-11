// 6通道 mel 端到端数值验证：node 跑 worker.js 真函数 vs torch 参考向量。
// 用法：node test_mel6.mjs（阈值 1e-4，float32 FFT+高斯窗累积误差内）。
import fs from 'fs';
import vm from 'vm';

const vec = JSON.parse(fs.readFileSync('/tmp/opencode/mel6_vec.json', 'utf8'));
const src = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const sandbox = {
  onmessage: null, // 'use strict' 下裸赋值需预置
  importScripts: () => {},
  postMessage: () => {},
  performance: { now: () => 0 },
  navigator: {},
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const seg = new Float32Array(vec.seg);
const frames = sandbox.makeFrames(seg);
console.log('frames:', frames.length, '(expect', 690 * 1024 + 4096, ')');
sandbox.gainNorm(frames);
const got = sandbox.framesToMel6(frames, 691);
const want = vec.mel;
let mx = 0, at = '';
for (let f = 0; f < 691; f++) for (let m = 0; m < 229; m++) for (let c = 0; c < 6; c++) {
  const d = Math.abs(got[(f * 229 + m) * 6 + c] - want[f][m][c]);
  if (d > mx) { mx = d; at = `f=${f} m=${m} c=${c} got=${got[(f * 229 + m) * 6 + c]} want=${want[f][m][c]}`; }
}
console.log('maxDiff=' + mx.toExponential(3), at);
console.log(mx < 1e-4 ? 'PASS mel6' : 'FAIL mel6');
