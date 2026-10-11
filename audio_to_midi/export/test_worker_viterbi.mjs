// Worker 级 Viterbi 植入自检 harness：在 node 里跑真实 worker.js 代码路径。
// 用法：node test_worker_viterbi.mjs 。exit 0=PASS。
import fs from 'fs';
import vm from 'vm';

const dir = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, dir), 'utf8');

const posted = [];
const sandbox = {
  onmessage: null, // worker.js 顶部 'use strict' 下直接赋值 onmessage，需预置
  postMessage: (m) => posted.push(m),
  importScripts: (p) => vm.runInContext(read(p), sandbox),
  performance,
  console,
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('viterbi.js'), sandbox);
vm.runInContext(read('worker.js'), sandbox);

sandbox.onmessage({ data: { type: 'viterbiSelftest' } });

const res = posted.find((m) => m.type === 'viterbiSelftest');
const logs = posted.filter((m) => m.type === 'log').map((m) => m.text);
console.log(logs.join('\n'));
if (res && res.ok && res.singletons === 2) {
  console.log(`WORKER VITERBI PASS (notes=${res.notes}, singletons=${res.singletons})`);
  process.exit(0);
} else {
  console.log('WORKER VITERBI FAIL', JSON.stringify(res));
  process.exit(1);
}
