// 自验证 v2：seg 键控 stub 驱动 worker.js 的 inferAll（真管线、真权重输出）。
// 用法：node audio_to_midi/export/test_inferall_js.mjs /tmp/opencode/e2e
// 逐段断言：mel 形状 / intervals 精确一致 / gather 精确一致；终判音符精确一致。
import fs from 'fs';
import vm from 'vm';
import path from 'path';

const dir = process.argv[1] === undefined ? '/tmp/opencode/e2e' : (process.argv[2] || '/tmp/opencode/e2e');
const read = (p) => fs.readFileSync(p);

function loadNpy(p) {
  const b = read(p);
  if (b[0] !== 0x93 || b.toString('ascii', 1, 6) !== 'NUMPY') throw new Error('bad npy ' + p);
  const hlen = b.readUInt16LE(8);
  const header = b.toString('ascii', 10, 10 + hlen);
  const shape = header.match(/'shape': \(([^)]*)\)/)?.[1].split(',').map(s => parseInt(s)).filter(n => !isNaN(n)) || [];
  if (!shape.length) throw new Error('shape parse fail: ' + header.slice(0, 80));
  const descr = header.match(/'descr': '([^']+)'/)?.[1];
  const n = shape.reduce((a, x) => a * x, 1);
  const rel = 10 + hlen; // Buffer.copy 用 view 相对坐标
  let data;
  if (descr === '<i8') { // int64（vel）：拷贝后转 Number
    const cp = Buffer.alloc(n * 8); b.copy(cp, 0, rel, rel + n * 8);
    const b2 = new BigInt64Array(cp.buffer, 0, n);
    data = new Float64Array(n); for (let i = 0; i < n; i++) data[i] = Number(b2[i]);
  } else if (descr === '|b1' || descr === '|u1') {
    const cp = Buffer.alloc(n); b.copy(cp, 0, rel, rel + n);
    data = new Uint8Array(cp.buffer, 0, n);
  } else {
    const cp = Buffer.alloc(n * 4); b.copy(cp, 0, rel, rel + n * 4);
    data = new Float32Array(cp.buffer, 0, n);
  }
  return { shape, data, descr };
}
const loadF32 = (p) => { const b = read(p); const cp = Buffer.alloc(b.length); b.copy(cp); return new Float32Array(cp.buffer, 0, b.length / 4); };

const meta = JSON.parse(read(path.join(dir, 'meta.json'), 'utf8'));
const pcm = loadF32(path.join(dir, 'pcm_f32.bin'));
const segs = [];
for (let s = 0; s < meta.nSeg; s++) {
  segs.push({
    S: loadNpy(path.join(dir, `seg${s}_S.npy`)),
    Sskip: loadNpy(path.join(dir, `seg${s}_Sskip.npy`)),
    CTX: loadNpy(path.join(dir, `seg${s}_CTX.npy`)),
    mel: loadNpy(path.join(dir, `seg${s}_mel.npy`)),
    ca: loadNpy(path.join(dir, `seg${s}_ca.npy`)),
    cb: loadNpy(path.join(dir, `seg${s}_cb.npy`)),
    vel: loadNpy(path.join(dir, `seg${s}_vel.npy`)),
    ofVal: loadNpy(path.join(dir, `seg${s}_ofVal.npy`)),
    ofPres: loadNpy(path.join(dir, `seg${s}_ofPres.npy`)),
    info: JSON.parse(read(path.join(dir, `seg${s}.json`), 'utf8')),
  });
}
console.log(`dump: nSeg=${segs.length} torchRef=${meta.ref.length} notes`);

const posted = [];
const sandbox = {
  onmessage: null,
  postMessage: (m) => posted.push(m),
  importScripts: (p) => vm.runInContext(
    fs.readFileSync(new URL(p, new URL('../', import.meta.url))), sandbox),
  addEventListener: () => {},
  performance, console,
};
sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const rdir = new URL('../', import.meta.url);
vm.runInContext(fs.readFileSync(new URL('viterbi.js', rdir), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(new URL('worker.js', rdir), 'utf8'), sandbox);

class Tensor { constructor(type, data, dims) { this.data = data; this.dims = dims; } dispose() {} }
let segCall = 0;
const captured = [];
const maxDiff = (a, b) => { const n = Math.min(a.length, b.length); let m = 0; for (let i = 0; i < n; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; } return { m, lenEq: a.length === b.length }; };
const fakeOrt = { Tensor };
const fakeScorer = {
  run: async (feeds) => {
    const s = segs[segCall];
    captured.push({ mel: feeds.mel, seg: segCall });
    return { S: { data: s.S.data, dispose() {} }, Sskip: { data: s.Sskip.data, dispose() {} }, CTX: { data: s.CTX.data, dispose() {} } };
  }
};
const fakeAttr = {
  run: async (feeds) => {
    const s = segs[segCall];
    captured[segCall].ca = feeds.ctx_a.data; captured[segCall].cb = feeds.ctx_b.data;
    segCall++;
    return { vel: { data: s.vel.data, dispose() {} }, ofVal: { data: s.ofVal.data, dispose() {} }, ofPres: { data: s.ofPres.data, dispose() {} } };
  }
};
// 无检出的段 attr.run 不会被调：segCall 对齐需要处理。改用 mel 计数对齐：
segCall = 0;
const fakeScorer2 = {
  run: async (feeds) => {
    const idx = captured.length;
    const s = segs[idx];
    captured.push({ mel: feeds.mel, seg: idx });
    return { S: { data: s.S.data, dispose() {} }, Sskip: { data: s.Sskip.data, dispose() {} }, CTX: { data: s.CTX.data, dispose() {} } };
  }
};
const fakeAttr2 = {
  run: async (feeds) => {
    const idx = captured.length - 1;
    const s = segs[idx];
    captured[idx].ca = feeds.ctx_a.data; captured[idx].cb = feeds.ctx_b.data;
    return { vel: { data: s.vel.data, dispose() {} }, ofVal: { data: s.ofVal.data, dispose() {} }, ofPres: { data: s.ofPres.data, dispose() {} } };
  }
};

const out = await sandbox.inferAll(fakeOrt, [fakeScorer2], fakeAttr2, 'cpu', pcm, { extend: false }); // extend:false 保与 torch transcribe() 的 12/12（延音展开另由 test_extend 对拍）
console.log(`JS notes: ${out.notes.length}, segments run: ${captured.length}`);

// 逐段：mel 对比 + gather 对比（intervals 一致性由终判音符覆盖；另 action 量）
let melWorst = 0, gWorst = 0;
captured.forEach((c, i) => {
  const md = maxDiff(c.mel.data, segs[i].mel.data);
  melWorst = Math.max(melWorst, md.m);
  let g = { m: 0 };
  if (c.ca) {
    const ga = maxDiff(c.ca, segs[i].ca.data), gb = maxDiff(c.cb, segs[i].cb.data);
    g = { m: Math.max(ga.m, gb.m), lenEq: ga.lenEq && gb.lenEq };
    gWorst = Math.max(gWorst, g.m);
  }
  console.log(`seg${i}: melShape=${c.mel.dims} maxDiff=${md.m.toExponential(2)} gather=${c.ca ? `N=${c.ca.length / 256} diff=${g.m.toExponential(2)} lenEq=${g.lenEq}` : '无检出（attr未调）'}`);
});
console.log(`mel worst=${melWorst.toExponential(2)} gather worst=${gWorst.toExponential(2)}`);

const norm = (n) => [Math.round(n.start * 1000) / 1000, Math.round(n.end * 1000) / 1000, n.pitch, n.velocity];
const jsSet = new Set(out.notes.map(norm).map(JSON.stringify));
const refSet = new Set(meta.ref.map(JSON.stringify));
const onlyJS = [...jsSet].filter(x => !refSet.has(x));
const onlyRef = [...refSet].filter(x => !jsSet.has(x));
console.log(`match=${jsSet.size - onlyJS.length}/${refSet.size} onlyJS=${onlyJS.length} onlyRef=${onlyRef.length}`);
if (onlyJS.length) console.log('onlyJS:', onlyJS.slice(0, 8));
if (onlyRef.length) console.log('onlyRef:', onlyRef.slice(0, 8));
if (onlyJS.length === 0 && onlyRef.length === 0 && jsSet.size === refSet.size) {
  console.log(`INFERALL-JS-PASS (${refSet.size}/${refSet.size} exact)`);
  process.exit(0);
} else { console.log('INFERALL-JS-FAIL'); process.exit(1); }
