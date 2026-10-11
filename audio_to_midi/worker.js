/* 音频转 MIDI · Worker：重采样 / 分段 / 6通道log-mel / ONNX推理 / Viterbi / SMF 写入
 * 特征契约（对标 Transkun ModelTransformer.ModelConfig + Util.py）：
 *   fs=44100 单声道, windowSize=4096, hopSize=1024, n_mels=229,
 *   f_min=30, f_max=8000, mel=torchaudio norm=None/htk（与checkpoint自带bank maxDiff 0.0）,
 *   eps=1e-5, log归一 ((mel+eps).log()-log(eps))/(-log(eps)),
 *   6通道STFT：hann主窗 + 5可学习高斯窗（sigma/center见GAUSS_*，与2.0.pt一致），
 *   每16s段独立 gain归一 (x-mean)/(std+1e-8)（与 processFramesBatch 一致，非整文件归一）。
 * 分段契约（对标 transcribe())：16s段/8s步/头尾各pad 8s，forcedStart链式传递，
 *   mergeIncompleteEvent + 末段 hasOffset + resolveOverlapping 全移植。
 * ONNX（export_transkun_onnx.py v3契约）：
 *   scorer: mel[1,691,229,6] → S[691,691,90](score[end,begin,sym]) / Sskip[690,90] / CTX[1,90,691,256]
 *   attr: ctx_a/b[N,256] → vel[N]int64 / ofVal[N,2] / ofPres[N,2]bool（CB均值等已在图内）
 * 解码：TranskunViterbi.decode（viterbi.js），端到端与 torch 12/12 音符精确一致
 *  （test_e2e_v3.py；多线程ORT的剃刀tie属模型噪声层，非移植误差）。
 */
'use strict';
importScripts('viterbi.js'); // Semi-CRF 后向 Viterbi（node --check 只做语法检查，不执行）
'use strict';

const FS = 44100, WIN = 4096, HOP = 1024, N_MELS = 229;
const F_MIN = 30, F_MAX = 8000, MEL_EPS = 1e-5;
const SEG_SEC = 16, STEP_SEC = 8;
const TARGET_PITCHES = [-64, -67];
for (let p = 21; p <= 108; p++) TARGET_PITCHES.push(p);

// ---- ONNX 运行时（ort web UMD 经 CDN 动态加载；模型字节由主线程经 OPFS/网络传入）----
// 注意：1.22 版已无 ort.web.min.js，UMD 全量包为 ort.all.min.js（暴露全局 ort）。
// 双 CDN 回退：jsdelivr 失败自动试 unpkg（曾实测 jsdelivr 旧路径 404 导致整页转写失败）。
const ORT_CDN_LIST = [
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.all.min.js',
  'https://unpkg.com/onnxruntime-web@1.22.0/dist/ort.all.min.js'
];
function loadOrt() {
  if (self.ort) return; // warmup 已加载过
  let lastErr = null;
  for (const url of ORT_CDN_LIST) {
    try { importScripts(url); if (self.ort) { log('ort 加载 ← ' + url); return; } }
    catch (e) { lastErr = e; log('ort 加载失败，换镜像：' + url); }
  }
  throw new Error('onnxruntime-web 全部镜像加载失败：' + (lastErr && lastErr.message || lastErr));
}

const log = (...a) => postMessage({ type: 'log', text: a.join(' ') });
const phase = (text, ratio) => postMessage({ type: 'phase', text, ratio });

// ---------- FFT（基2，4096点） ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2], bi = im[i + k + len / 2];
        const vr = br * cwr - bi * cwi, vi = br * cwi + bi * cwr;
        re[i + k] = ar + vr; im[i + k] = ai + vi;
        re[i + k + len / 2] = ar - vr; im[i + k + len / 2] = ai - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
}
const HANN = (() => {
  const w = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / WIN));
  return w;
})();
// 5组可学习高斯窗（2.0.pt实测全精度值，Y=exp(-0.5*((x-4096c)/(s*4096/2))^2)），
// 与 export/gauss_windows.json 完全一致（取4位小数会引入 2.5e-4 窗误差，不可省略精度）
const GAUSS_SIGMA = [0.23673050105571747, 0.30765897035598755, 0.6513311266899109, 0.336031436920166, 0.22925055027008057];
const GAUSS_CENTER = [0.3427625298500061, 0.4463801681995392, 0.49210235476493835, 0.5828545093536377, 0.720033586025238];
const GAUSS_WINS = GAUSS_SIGMA.map((s, k) => {
  const c = GAUSS_CENTER[k], w = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) {
    const t = (i - WIN * c) / (s * WIN / 2);
    w[i] = Math.exp(-0.5 * t * t);
  }
  return w;
});

// ---------- mel 滤波器组（与 torchaudio melscale_fbanks 默认一致：htk、无面积归一） ----------
// 注：checkpoint 自带的 freq2mels 经实测与 norm=None 版 maxDiff=0.0（slaney 版差 0.98），
// 故此处故意不做 slaney enorm——这是对的，不是漏写。
function buildMelBank() {
  const hz2mel = f => 2595 * Math.log10(1 + f / 700);
  const mel2hz = m => 700 * (Math.pow(10, m / 2595) - 1);
  const melMin = hz2mel(F_MIN), melMax = hz2mel(F_MAX);
  const nFreqs = WIN / 2 + 1;
  const melPts = [];
  for (let i = 0; i < N_MELS + 2; i++) melPts.push(mel2hz(melMin + i * (melMax - melMin) / (N_MELS + 1)));
  const bank = [];
  for (let m = 1; m <= N_MELS; m++) {
    const f0 = melPts[m - 1], f1 = melPts[m], f2 = melPts[m + 1];
    const row = new Float32Array(nFreqs);
    for (let k = 0; k < nFreqs; k++) {
      const f = k * (FS / 2) / (nFreqs - 1);
      row[k] = f <= f0 || f >= f2 ? 0 : (f <= f1 ? (f - f0) / (f1 - f0) : (f2 - f) / (f2 - f1));
    }
    bank.push(row);
  }
  return bank;
}
const MEL_BANK = buildMelBank();

// ---------- 主流程 ----------
onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'probeBackend') return probeBackend();
  if (msg.type === 'viterbiSelftest') return viterbiPlantedTest();
  if (msg.type === 'warmup') return warmup(); // 进页预热：提前加载 ort（错误早暴露），不跑推理
  if (msg.type !== 'transcribe') return;
  const t0 = performance.now();
  try {
    phase('重采样到 44.1kHz…', 0.05);
    let pcm = msg.pcm, sr = msg.sampleRate;
    if (sr !== FS) pcm = resample(pcm, sr, FS);
    const tRs = performance.now();

    let notes, mode, segDiag = null;
    if (!msg.models) throw new Error('未收到模型字节（主线程应先经 OPFS/网络备好双权重）');
    const r = await runModel(pcm, msg.models);
    notes = r.notes; segDiag = r.diag; mode = 'onnx';
    const tInf = performance.now();

    phase('生成 MIDI…', 0.92);
    const midiBytes = writeMidi(notes);
    phase('完成', 1);
    postMessage({
      type: 'done', midi: midiBytes.buffer, notes, mode,
      diag: Object.assign({ msResample: tRs - t0, msInfer: tInf - tRs, msTotal: performance.now() - t0 }, segDiag || {})
    }, [midiBytes.buffer]);
  } catch (err) {
    postMessage({ type: 'error', text: String((err && err.stack) || err) });
  }
};

function resample(pcm, srIn, srOut) {
  const ratio = srIn / srOut, n = Math.floor(pcm.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, i0 = Math.floor(p), f = p - i0;
    out[i] = pcm[i0] * (1 - f) + (pcm[Math.min(i0 + 1, pcm.length - 1)] || 0) * f;
  }
  return out;
}

// 对标 Util.makeFrame：nFrame=ceil(N/hop)+1，左补 WIN/2
function makeFrames(pcm) {
  const nFrame = Math.ceil(pcm.length / HOP) + 1;
  const buf = new Float32Array((nFrame - 1) * HOP + WIN);
  buf.set(pcm, WIN / 2);
  return buf;
}
const _re = new Float64Array(WIN), _im = new Float64Array(WIN);
// hann → rfft(ortho) → 功率谱 → mel → log归一（对标 MelSpectrum.forward）
function framesToMel(frames, nFrame) {
  const out = new Float32Array(nFrame * N_MELS);
  const ortho = 1 / Math.sqrt(WIN);
  const logEps = Math.log(MEL_EPS), negLogEps = -logEps;
  for (let f = 0; f < nFrame; f++) {
    const off = f * HOP;
    for (let i = 0; i < WIN; i++) { _re[i] = frames[off + i] * HANN[i]; _im[i] = 0; }
    fft(_re, _im);
    for (let m = 0; m < N_MELS; m++) {
      let s = 0;
      const row = MEL_BANK[m];
      for (let k = 0; k <= WIN / 2; k++) {
        // 与 torch 一致：直接取 |rfft|²（ortho 归一），不做单边谱 ×2
        // （torch.stft/rfft 的 onesided 输出就是原始 DFT bin，无加倍）
        let p = _re[k] * _re[k] + _im[k] * _im[k];
        p *= ortho * ortho;
        s += p * row[k];
      }
      out[f * N_MELS + m] = (Math.log(s + MEL_EPS) - logEps) / negLogEps;
    }
    if ((f & 255) === 255) phase('提取 log-mel（229维）…', 0.2 + 0.35 * f / nFrame);
  }
  return out;
}

// ---------- SMF 写入（对标 Data.writeMidi：format0, resolution 960, Grand Piano） ----------
function varlen(v) {
  const bytes = [v & 0x7f];
  v >>>= 7;
  while (v) { bytes.unshift((v & 0x7f) | 0x80); v >>>= 7; }
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return bytes;
}
function writeMidi(notes) {
  const ev = [];
  const tpq = 960, bpm = 120, spb = Math.round(60000000 / bpm);
  ev.push(...[0x00, 0xFF, 0x51, 0x03, (spb >> 16) & 0xff, (spb >> 8) & 0xff, spb & 0xff]);
  ev.push(...[0x00, 0xC0, 0x00]); // program 0 Acoustic Grand Piano, ch0
  const raw = [];
  for (const n of notes) {
    const on = Math.round(n.start * tpq * bpm / 60), off = Math.round(n.end * tpq * bpm / 60);
    if (n.pitch > 0) {
      raw.push([on, [0x90, n.pitch, Math.max(1, Math.min(127, n.velocity | 0))]]);
      raw.push([off, [0x80, n.pitch, 0]]);
    } else {
      const cc = -n.pitch;
      raw.push([on, [0xB0, cc, 100]]);
      raw.push([off, [0xB0, cc, 0]]);
    }
  }
  raw.sort((a, b) => a[0] - b[0]);
  let last = 0;
  for (const [t, b] of raw) { ev.push(...varlen(t - last), ...b); last = t; }
  ev.push(...[0x00, 0xFF, 0x2F, 0x00]);
  const head = [0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01,
    (tpq >> 8) & 0xff, tpq & 0xff, 0x4d, 0x54, 0x72, 0x6b,
    (ev.length >>> 24) & 0xff, (ev.length >>> 16) & 0xff, (ev.length >>> 8) & 0xff, ev.length & 0xff];
  return new Uint8Array([...head, ...ev]);
}

/* ---------- 真实推理链（阶段2已落地） ----------
 * 布局：S Float32Array(T*T*90)，score[end,begin,sym]（test_e2e_v3.py 定轴：A 向命中 12/12）；
 *   Sskip (T-1)*90；CTX (90*T*256)，按 [sym,frame] 取端点（与 fetchIntervalFeaturesBatch 同语义）。
 * decodeScoresToNotes 保留给 viterbiPlantedTest（植入自检，不经模型）。
 */
const FRAME_DUR = HOP / FS; // 1024/44100 ≈ 23.22ms（与 torch 的 frameDur 一致）
function symToPitch(s){ return s === 0 ? -64 : s === 1 ? -67 : 21 + (s - 2); }

// S: Float32Array(T*T*90)，skip: Float32Array(T*90 或 (T-1)*90)；返回 Note[]（秒）。
function decodeScoresToNotes(S, skip, T, skipRows){
  const NSYM = 90;
  const notes = [];
  let singletons = 0;
  for(let s = 0; s < NSYM; s++){
    const list = TranskunViterbi.decode({
      T,
      getScore: (e, b) => S[(e * T + b) * NSYM + s],
      getSkip: (t) => skip[t * NSYM + s],
      forcedStart: 0
    });
    const pitch = symToPitch(s);
    for(const [bi, ei] of list){
      if(ei <= bi){ singletons++; continue; } // 单点事件：2b 之前只计数
      notes.push({ start: bi * FRAME_DUR, end: ei * FRAME_DUR, pitch, velocity: 80 });
    }
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { notes, singletons };
}

// 植入区间自检：合成 S（pitch60 在 [100,200] 放 25 分强区间），验 decode→notes 全链。
// 经 export/test_worker_viterbi.mjs 在 node 里跑（浏览器端暂不设按钮）。
function viterbiPlantedTest(){
  const T = 300, NSYM = 90, s60 = 2 + (60 - 21);
  const S = new Float32Array(T * T * NSYM);
  const skip = new Float32Array((T - 1) * NSYM);
  S[(200 * T + 100) * NSYM + s60] = 25;
  // 对角只在区间端点放 5 分：skip 链累积 10 分 < 25，span 获胜且带 2 个单点（验共存）
  S[(100 * T + 100) * NSYM + s60] = 5;
  S[(200 * T + 200) * NSYM + s60] = 5;
  const { notes, singletons } = decodeScoresToNotes(S, skip, T, T - 1);
  const hit = notes.filter(n => n.pitch === 60 && Math.abs(n.start - 100 * FRAME_DUR) < 1e-9 &&
    Math.abs(n.end - 200 * FRAME_DUR) < 1e-9);
  const others = notes.filter(n => n.pitch !== 60);
  const ok = hit.length === 1 && others.length === 0;
  const text = `Viterbi植入自检 ${ok ? 'PASS' : 'FAIL'}：pitch60 [100,200]帧→` +
    `[${(100 * FRAME_DUR).toFixed(3)}s, ${(200 * FRAME_DUR).toFixed(3)}s] ` +
    `命中${hit.length}/1，非目标音符${others.length}，单点事件${singletons}个（已计数丢弃）`;
  log(text);
  postMessage({ type: 'viterbiSelftest', ok, notes: notes.length, singletons });
  return ok;
}
async function runModel(pcm, models) {
  loadOrt(); // 双 CDN 回退加载（动态，不阻塞页面）
  const ortNS = self.ort;
  // 后端：优先 WebGPU，失败回退 WASM（任务6要求明示回退）
  let providers = ['wasm'], backend = 'wasm';
  try {
    if (self.navigator && self.navigator.gpu && (await self.navigator.gpu.requestAdapter())) {
      providers = ['webgpu'];
      backend = 'webgpu';
    }
  } catch (_) { /* 回退 wasm */ }
  const mkSession = async (buf, providers) =>
    ortNS.InferenceSession.create(buf, { executionProviders: providers });
  phase(`加载 ONNX（${backend}）…`, 0.3);
  let scorer, attr;
  try {
    scorer = await mkSession(models.scorer, providers);
    attr = await mkSession(models.attr, providers);
  } catch (err) {
    if (backend === 'webgpu') {
      log('WebGPU 会话失败，回退 WASM：' + (err && err.message || err));
      backend = 'wasm'; providers = ['wasm'];
      scorer = await mkSession(models.scorer, providers);
      attr = await mkSession(models.attr, providers);
    } else throw err;
  }
  log(`ONNX 就绪：后端=${backend}，S=${scorer.outputNames}，attr=${attr.outputNames}`);

  // 分段常量（与 transcribe() 逐行对齐）
  const SEG = Math.ceil(SEG_SEC * FS);          // 705600 采样
  const STEP = Math.ceil(STEP_SEC * FS / HOP) * HOP; // 353280 采样
  const PAD = Math.ceil((SEG_SEC - STEP_SEC) * FS);  // 352800 采样
  const T = 691, LAST_F = 689, STEP_F = STEP / HOP;  // 345 帧
  const padded = new Float32Array(PAD + pcm.length + PAD);
  padded.set(pcm, PAD);
  const nSample = padded.length;
  let startPos = new Array(90).fill(Math.floor(PAD / HOP)); // 344
  const eventsByType = new Map(); // pitch -> Note[](hasOnset/hasOffset 保留到终筛)
  let segIdx = 0, nSegTotal = 0;
  for (let s0 = 0; s0 < nSample; s0 += STEP) nSegTotal++;
  for (let s0 = 0; s0 < nSample; s0 += STEP) {
    segIdx++;
    phase(`推理 ${segIdx}/${nSegTotal} 段…`, 0.3 + 0.55 * segIdx / nSegTotal);
    const slice = padded.subarray(s0, Math.min(s0 + SEG, nSample));
    const seg = slice.length < SEG ? (() => { const z = new Float32Array(SEG); z.set(slice); return z; })() : slice;
    const frames = makeFrames(seg); // 691 帧
    gainNorm(frames);
    const mel = framesToMel6(frames, T); // [691,229,6]
    const melT = new ortNS.Tensor('float32', mel, [1, T, N_MELS, 6]);
    const out = await scorer.run({ mel: melT });
    const S = out.S.data, Sskip = out.Sskip.data, CTX = out.CTX.data;
    // 90 symbol 各自 Viterbi（与 torch nBatch=nSym 等价）
    const intervals = [];
    for (let sym = 0; sym < 90; sym++) {
      intervals.push(TranskunViterbi.decode({
        T,
        getScore: (e, b) => S[(e * T + b) * 90 + sym],
        getSkip: (t) => Sskip[t * 90 + sym],
        forcedStart: startPos[sym]
      }));
    }
    // 属性头（无检出则跳过）
    let total = 0;
    for (let sym = 0; sym < 90; sym++) total += intervals[sym].length;
    let vel = [], ofVal = [], ofPres = [];
    if (total > 0) {
      const ca = new Float32Array(total * 256), cb = new Float32Array(total * 256);
      let n = 0;
      for (let sym = 0; sym < 90; sym++) {
        for (const [b, e] of intervals[sym]) {
          ca.set(CTX.subarray((sym * T + b) * 256, (sym * T + b) * 256 + 256), n * 256);
          cb.set(CTX.subarray((sym * T + e) * 256, (sym * T + e) * 256 + 256), n * 256);
          n++;
        }
      }
      const ao = await attr.run({
        ctx_a: new ortNS.Tensor('float32', ca, [total, 256]),
        ctx_b: new ortNS.Tensor('float32', cb, [total, 256])
      });
      vel = ao.vel.data; ofVal = ao.ofVal.data; ofPres = ao.ofPres.data;
    }
    // 组装（与 transcribeFrames/test_e2e_v3.assemble 逐行对齐）
    const beginTime = s0 / FS - (SEG_SEC - STEP_SEC);
    const lastP = new Array(90).fill(0);
    let n = 0;
    const curNotes = [];
    for (let sym = 0; sym < 90; sym++) {
      const pitch = symToPitch(sym);
      let lastEnd = 0, curLastP = 0;
      for (const [b, e] of intervals[sym]) {
        let start = (b + ofVal[n * 2]) * FRAME_DUR;
        let end = (e + ofVal[n * 2 + 1]) * FRAME_DUR;
        const hasOnset = (b > 0) || !!ofPres[n * 2];
        const hasOffset = (e < LAST_F) || !!ofPres[n * 2 + 1];
        start = Math.max(start, lastEnd);
        end = Math.max(end, start + 1e-8);
        lastEnd = end;
        const ev = { start: start + beginTime, end: end + beginTime, pitch, velocity: Number(vel[n]), hasOnset, hasOffset };
        ev.start = Math.max(ev.start, 0);
        ev.end = Math.max(ev.end, ev.start);
        curNotes.push(ev);
        if (hasOffset) curLastP = e;
        n++;
      }
      lastP[sym] = curLastP;
    }
    // 段间合并（与 transcribe() mergeIncompleteEvent 逐行对齐）
    for (const ev of curNotes) {
      const arr = eventsByType.get(ev.pitch) || [];
      if (arr.length > 0) {
        const last = arr[arr.length - 1];
        if (ev.start < last.end) {
          if (ev.hasOnset) arr[arr.length - 1] = ev;
          else { last.hasOffset = ev.hasOffset; last.end = Math.max(ev.end, last.end); }
          continue;
        }
      }
      if (ev.hasOnset) { arr.push(ev); eventsByType.set(ev.pitch, arr); }
    }
    startPos = lastP.map(v => Math.max(v - STEP_F, 0));
  }
  // 终筛（与 transcribe() 尾部逐行对齐）：末事件 hasOffset → 只留有offset → resolveOverlapping
  let eventsAll = [];
  for (const arr of eventsByType.values()) {
    if (arr.length > 0) arr[arr.length - 1].hasOffset = true;
    eventsAll = eventsAll.concat(arr);
  }
  eventsAll = eventsAll.filter(v => v.hasOffset);
  eventsAll = resolveOverlapping(eventsAll);
  const notes = eventsAll.map(v => ({ start: v.start, end: v.end, pitch: v.pitch, velocity: v.velocity }));
  log(`转写完成：${notes.length} 音符（ pedals=${notes.filter(v => v.pitch < 0).length}），后端=${backend}`);
  return { notes, diag: { segments: nSegTotal, backend } };
}

// resolveOverlapping（与 Data.py 逐行对齐：同pitch后音截断前音，丢弃 start>=end）
function resolveOverlapping(evs) {
  evs.sort((a, b) => a.start - b.start || a.end - b.end || a.pitch - b.pitch);
  const out = [], buf = new Map();
  for (const ev of evs) {
    if (buf.has(ev.pitch)) {
      const prev = out[buf.get(ev.pitch)];
      if (prev.end > ev.start) prev.end = ev.start;
    }
    buf.set(ev.pitch, out.length);
    out.push(ev);
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end || a.pitch - b.pitch);
  return out.filter(v => v.start < v.end);
}

function gainNorm(frames) {
  let mean = 0;
  for (let i = 0; i < frames.length; i++) mean += frames[i];
  mean /= frames.length;
  let vv = 0;
  for (let i = 0; i < frames.length; i++) { const d = frames[i] - mean; vv += d * d; }
  const std = Math.sqrt(vv / frames.length);
  for (let i = 0; i < frames.length; i++) frames[i] = (frames[i] - mean) / (std + 1e-8);
}

// 6通道 log-mel（hann + 5高斯窗 → rfft(ortho) → 功率谱 → mel(norm=None) → log归一）
// 输出布局 [T,229,6]（与 onnx mel 输入 [1,T,229,6] 的行主序一致）
function framesToMel6(frames, nFrame) {
  const out = new Float32Array(nFrame * N_MELS * 6);
  const wins = [HANN, ...GAUSS_WINS];
  const ortho = 1 / Math.sqrt(WIN);
  const logEps = Math.log(MEL_EPS), negLogEps = -logEps;
  for (let f = 0; f < nFrame; f++) {
    const off = f * HOP;
    for (let c = 0; c < 6; c++) {
      const win = wins[c];
      for (let i = 0; i < WIN; i++) { _re[i] = frames[off + i] * win[i]; _im[i] = 0; }
      fft(_re, _im);
      const base = (f * N_MELS) * 6 + c;
      for (let m = 0; m < N_MELS; m++) {
        let s = 0;
        const row = MEL_BANK[m];
        for (let k = 0; k <= WIN / 2; k++) {
          let p = _re[k] * _re[k] + _im[k] * _im[k];
          p *= ortho * ortho;
          s += p * row[k];
        }
        out[base + m * 6] = (Math.log(s + MEL_EPS) - logEps) / negLogEps;
      }
    }
    if ((f & 127) === 127) phase('提取 log-mel（229维×6通道）…', 0.2 + 0.1 * f / nFrame);
  }
  return out;
}

// 预热：只加载 ort，不建会话不推理；供主线程进页调用，错误早暴露
function warmup() {
  try {
    loadOrt();
    postMessage({ type: 'warmupOk', hasOrt: !!self.ort });
  } catch (err) {
    postMessage({ type: 'error', text: '预热失败：' + String((err && err.message) || err) });
  }
}

// 后端探测：WebGPU 可用性（阶段4 在此分支显示“WASM 回退”提示）
async function probeBackend() {
  let webgpu = false, info = '';
  try {
    if (navigator.gpu) {
      const ad = await navigator.gpu.requestAdapter();
      webgpu = !!ad;
      info = ad ? String((await ad.requestDevice()).label || 'adapter ok') : 'no adapter';
    }
  } catch (err) { info = String((err && err.message) || err); }
  postMessage({ type: 'backend', webgpu, info, fallback: webgpu ? 'webgpu' : 'wasm' });
}
