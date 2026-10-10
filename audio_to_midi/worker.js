/* 音频转 MIDI · Worker：重采样 / 分帧 / log-mel / 分段 / SMF 写入
 * 特征契约（对标 Transkun ModelTransformer.ModelConfig + Util.py）：
 *   fs=44100 单声道, windowSize=4096, hopSize=1024, n_mels=229,
 *   f_min=30, f_max=8000, mel=torchaudio slaney/htk, eps=1e-5,
 *   log归一 ((mel+eps).log()-log(eps))/(-log(eps)),
 *   帧先做整体 gain归一 (x-mean)/(std+1e-8), 再进mel。
 * 注意：nExtraWins=5 的可学习高斯窗是权重的一部分，无权重时只用 hann 主窗。
 * 真实推理钩子：ORT_MODEL_URL（阶段2接 onnxruntime-web + 手写 Viterbi，见文件尾）。
 */
'use strict';

const FS = 44100, WIN = 4096, HOP = 1024, N_MELS = 229;
const F_MIN = 30, F_MAX = 8000, MEL_EPS = 1e-5;
const SEG_SEC = 16, STEP_SEC = 8;
const TARGET_PITCHES = [-64, -67];
for (let p = 21; p <= 108; p++) TARGET_PITCHES.push(p);

// ---- ONNX 权重钩子（阶段2填写后即插即用，OPFS 缓存由主线程负责）----
const ORT_MODEL_URL = '';
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.web.min.js';

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

// ---------- mel 滤波器组（slaney 面积归一 + htk，与 torchaudio 默认一致） ----------
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
    const enorm = 2 / (f2 - f0);
    for (let k = 0; k < nFreqs; k++) row[k] *= enorm;
    bank.push(row);
  }
  return bank;
}
const MEL_BANK = buildMelBank();

// ---------- 主流程 ----------
onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'probeBackend') return probeBackend();
  if (msg.type !== 'transcribe') return;
  const t0 = performance.now();
  try {
    phase('重采样到 44.1kHz…', 0.05);
    let pcm = msg.pcm, sr = msg.sampleRate;
    if (sr !== FS) pcm = resample(pcm, sr, FS);
    const tRs = performance.now();

    phase('分帧（4096窗/1024跳）…', 0.12);
    const frames = makeFrames(pcm);
    const nFrame = frames.length / WIN;

    let mean = 0;
    for (let i = 0; i < frames.length; i++) mean += frames[i];
    mean /= frames.length;
    let vv = 0;
    for (let i = 0; i < frames.length; i++) { const d = frames[i] - mean; vv += d * d; }
    const std = Math.sqrt(vv / frames.length);
    for (let i = 0; i < frames.length; i++) frames[i] = (frames[i] - mean) / (std + 1e-8);
    const tNorm = performance.now();

    phase('提取 log-mel（229维）…', 0.2);
    const mel = framesToMel(frames, nFrame);
    const tMel = performance.now();

    const segLen = Math.round(SEG_SEC * FS / HOP), stepLen = Math.round(STEP_SEC * FS / HOP);
    let nSeg = 0;
    for (let s = 0; s < nFrame; s += stepLen) nSeg++;

    let notes, mode;
    if (!ORT_MODEL_URL || msg.selftest) {
      phase('链路自检：合成测试音阶（不经模型）…', 0.6);
      notes = selftestScale();
      mode = 'selftest';
      log(`自检模式：特征 ${nFrame}帧×${N_MELS}维 / ${nSeg}段就绪；输出为合成音阶，仅验链路`);
    } else {
      notes = await runModel(mel, nFrame, segLen, stepLen);
      mode = 'onnx';
    }
    const tInf = performance.now();

    phase('生成 MIDI…', 0.92);
    const midiBytes = writeMidi(notes);
    phase('完成', 1);
    postMessage({
      type: 'done', midi: midiBytes.buffer, notes, mode,
      diag: { frames: nFrame, mels: N_MELS, segments: nSeg, msResample: tRs - t0, msNorm: tNorm - tRs, msMel: tMel - tNorm, msInfer: tInf - tMel, msTotal: performance.now() - t0 }
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
        let p = _re[k] * _re[k] + _im[k] * _im[k];
        p *= ortho * ortho;
        if (k > 0 && k < WIN / 2) p *= 2; // rfft 单边谱能量修正
        s += p * row[k];
      }
      out[f * N_MELS + m] = (Math.log(s + MEL_EPS) - logEps) / negLogEps;
    }
    if ((f & 255) === 255) phase('提取 log-mel（229维）…', 0.2 + 0.35 * f / nFrame);
  }
  return out;
}

// 链路自检：C大调上行音阶（明确标记为合成，非模型输出）
function selftestScale() {
  const scale = [60, 62, 64, 65, 67, 69, 71, 72];
  const notes = scale.map((p, i) => ({ start: i * 0.45, end: i * 0.45 + 0.4, pitch: p, velocity: 80 }));
  notes.push({ start: 0, end: scale.length * 0.45, pitch: -64, velocity: 100 }); // 踏板事件
  return notes;
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

/* ---------- 阶段2钩子：ONNX 推理 + 手写 Viterbi ----------
 * 导出策略（已定）：只导出 Transformer 评分网络 + velocity/refine 头；
 * Semi-CRF 的 Viterbi 动态规划在 JS 手写（C++ 扩展无法进 ONNX）。
 * runModel 输入：mel [nFrame×229]；输出：Note[{start,end,pitch,velocity}]（秒）。
 * 段合并语义照抄 transcribe()：forcedStartPos + mergeIncompleteEvent +
 * resolveOverlapping + 末段 hasOffset=true。权重到位后实现本函数即可，
 * 上游调用链（分段/进度/SMF）不用动。
 */
async function runModel(mel, nFrame, segLen, stepLen) {
  importScripts(ORT_CDN); // onnxruntime-web（动态加载，不阻塞页面）
  throw new Error('ONNX 权重未就绪：ORT_MODEL_URL 为空（阶段2任务）');
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
