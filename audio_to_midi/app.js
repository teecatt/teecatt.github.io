/* 音频转 MIDI · 主线程：上传解码 / OPFS 模型缓存 / Worker 调度 / 卷帘预览 / 诊断
 * 权重：R2 双文件（scorer 57MB + attr 3.4MB），OPFS 缓存 + 字节数校验。
 *（测试音阶自检已删除；Viterbi 植入自检保留在 worker 供 node 测试用，不经 UI。）
 */
'use strict';

// 全局错误进页日志：加载期/运行时未捕获异常直接写进调试面板（不再只躺F12控制台）。
// 放第一行，保证后面任何初始化暴毙都留字条。
window.addEventListener('error', (e) => {
  try {
    const box = document.getElementById('diag');
    if (!box) return;
    if (box.dataset.init !== '1') { box.textContent = ''; box.dataset.init = '1'; }
    const line = document.createElement('div');
    line.className = 'err';
    line.textContent = `[${ts()}] ✗ 页面错误：` + String((e && e.message) || e) +
      (e && e.lineno ? `（${e.lineno}行）` : '') + ' —— 把这行贴给开发者';
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  } catch (_) {}
});

// ---- 权重地址（R2，OPFS 缓存 + 字节数校验）----
const MODEL_R2 = 'https://weights.down2.top';
const MODEL_R2_DIRECT = 'https://pub-b8d95e05900c4ad98bf1420adcda0148.r2.dev';
const MODEL_FILES = [
  { key: 'scorer', urls: [MODEL_R2 + '/transkun_scorer.onnx', MODEL_R2_DIRECT + '/transkun_scorer.onnx'], name: 'transkun_scorer.onnx', size: 57104274 },
  { key: 'scorerFp16', urls: [MODEL_R2 + '/transkun_scorer_fp16.onnx', MODEL_R2_DIRECT + '/transkun_scorer_fp16.onnx'], name: 'transkun_scorer_fp16.onnx', size: 30750038 }, // WebGPU 专用（半显存；位置精确、力度±2，见 dump_fp16 验证）
  { key: 'attr', urls: [MODEL_R2 + '/transkun_attr.onnx', MODEL_R2_DIRECT + '/transkun_attr.onnx'], name: 'transkun_attr.onnx', size: 3427886 },
];

const $ = id => document.getElementById(id);
const diagBox = $('diag');
// 调试面板时间戳（本地时分秒.毫秒）：面板内所有行统一前缀，还原手机端无 F12 时的时序。
function ts() {
  const d = new Date(), p = (n, l) => String(n).padStart(l, '0');
  return `${p(d.getHours(), 2)}:${p(d.getMinutes(), 2)}:${p(d.getSeconds(), 2)}.${p(d.getMilliseconds(), 3)}`;
}
function dlog(text, cls, buffered) {
  if (diagBox.dataset.init !== '1') { diagBox.textContent = ''; diagBox.dataset.init = '1'; }
  // 高频进度行（worker phase / 下载 onLive）走 500ms 批量刷屏：时间戳在调用时取，
  // 时序不丢，但每行 appendChild + scrollTop 同步回流只在 flush 时发生一次。
  // err 行永远直写（崩溃前必须留字条）。
  if (buffered && cls !== 'err') {
    lineBuf.push({ t: ts(), text, cls });
    if (!flushTimer) flushTimer = setTimeout(flushLines, 500);
    return;
  }
  appendLine(ts(), text, cls);
}
function makeLine(stamp, text, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${stamp}] ` + (cls === 'err' ? '✗ ' : cls === 'warn' ? '⚠ ' : '· ') + text;
  return line;
}
function appendLine(stamp, text, cls) {
  diagBox.appendChild(makeLine(stamp, text, cls));
  diagBox.scrollTop = diagBox.scrollHeight;
}
let lineBuf = [], flushTimer = null;
function flushLines() {
  flushTimer = null;
  if (!lineBuf.length) return;
  const frag = document.createDocumentFragment();
  for (const { t, text, cls } of lineBuf) frag.appendChild(makeLine(t, text, cls));
  lineBuf = [];
  diagBox.appendChild(frag);
  diagBox.scrollTop = diagBox.scrollHeight;
}

// ---------- 调试面板按钮：清空 / 复制
$('diagClear').onclick = () => {
  diagBox.textContent = ''; // 清空日志
  delete diagBox.dataset.init; // 重置初始化标记，下次 dlog 重新走初始化分支
  lineBuf = []; // 丢弃未刷屏的缓冲行
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
};
function diagCopyFeedback(ok) {
  const btn = $('diagCopy');
  if (!btn) return;
  if (!btn.dataset.orig) btn.dataset.orig = btn.textContent; // 记住原始文案“⧉ 复制”
  btn.textContent = ok ? '✓ 已复制' : '复制失败';
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = btn.dataset.orig || '⧉ 复制'; }, 1200);
}
function diagCopyFallback(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    diagCopyFeedback(!!ok);
  } catch (_) { diagCopyFeedback(false); }
}
$('diagCopy').onclick = () => {
  const text = diagBox.innerText || '';
  if (!text) { diagCopyFeedback(false); return; } // 空日志也给“复制失败”反馈
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => diagCopyFeedback(true), () => diagCopyFallback(text));
  } else {
    diagCopyFallback(text);
  }
};

let audioFile = null, pcmMono = null, sampleRate = 0, midiBlob = null, worker = null;

function getWorker() {
  if (!worker) {
    worker = new Worker('./worker.js?v=18');
    worker.onmessage = onWorkerMsg;
    worker.onerror = e => { transcribing = false; unlockScreen(); dlog('Worker 错误：' + JSON.stringify({ message: e && e.message, filename: e && e.filename, lineno: e && e.lineno }) + '（多为 worker 崩溃/OOM/脚本加载失败；看上一行日志定位阶段）', 'err'); };
    worker.postMessage({ type: 'probeBackend' });
    worker.postMessage({ type: 'warmup' }); // 约定消息名：通知 worker 后台预热 ort（worker 侧实现，就绪后回 warmupOk）
  }
  return worker;
}

// ---------- 屏幕常亮锁（转写期间防后台冻结；无 API 全程静默跳过） ----------
let wakeLock = null, transcribing = false;
async function lockScreen() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    try { wakeLock.addEventListener('release', () => { if (transcribing) wakeLock = null; }); } catch (_) {}
    dlog('屏幕常亮已锁（防后台冻结）', 'ok');
  } catch (err) {
    wakeLock = null;
    dlog('屏幕常亮申请失败（不拦转写）：' + (err && err.message || err), 'warn');
  }
}
async function unlockScreen() {
  try { if (wakeLock) await wakeLock.release(); } catch (_) {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && transcribing && !wakeLock) lockScreen();
});

// ---------- 上传 ----------
const drop = $('drop'), fileInput = $('file');
drop.onclick = () => fileInput.click();
['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]); });
fileInput.onchange = () => { if (fileInput.files[0]) pickFile(fileInput.files[0]); };

// 测试样例（同源，无 CORS 问题）：audio_to_midi/test/AfterSchool.mp3（3.5MB，约233秒）
const SAMPLE_DEFAULT = 'test/AfterSchool.mp3';
async function fetchSample(url) {
  dlog('测试入口：加载 sample=' + url);
  const r = await fetch(url);
  if (!r.ok) throw new Error('sample 下载失败：HTTP ' + r.status);
  const blob = await r.blob();
  const name = decodeURIComponent(url.split('?')[0].split('/').pop() || 'sample.mp3');
  pickFile(new File([blob], name, { type: blob.type || 'audio/mpeg' }));
}
const sampleBtn = $('sampleBtn');
if (sampleBtn) sampleBtn.onclick = () => { location.href = '?sample=' + encodeURIComponent(SAMPLE_DEFAULT); };

async function pickFile(f) {
  audioFile = f; pcmMono = null; midiBlob = null;
  armFreshAudio(); // 新文件：废弃旧断点
  $('dl').disabled = true;
  if ($('playv2')) $('playv2').disabled = true;
  $('fileInfo').textContent = `${f.name}（${(f.size / 1048576).toFixed(1)} MB）· 解码中…`;
  dlog(`选择文件：${f.name}，${f.size} 字节`);
  try {
    const t0 = performance.now();
    const ab = await f.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const buf = await ctx.decodeAudioData(ab);
    await ctx.close();
    sampleRate = buf.sampleRate;
    const n = buf.length, ch = buf.numberOfChannels;
    pcmMono = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) pcmMono[i] += d[i] / ch;
    }
    dlog(`解码完成：${n} 采样 / ${sampleRate}Hz / ${ch}声道→单声道，${(performance.now() - t0).toFixed(0)}ms`, 'ok');
    $('fileInfo').textContent = `${f.name} · ${(n / sampleRate).toFixed(1)}s · ${sampleRate}Hz`;
    if (!prefetching) $('go').disabled = false; // 预下载中则等 finally 统一恢复，避免并行双下载
    if (!prefetching && !$('go').disabled) $('go').click(); else if (prefetching) autoGo = true; // 解码完成即自动转写
  } catch (err) {
    dlog('解码失败：' + (err && err.message || err) + '（请用 MP3/WAV）', 'err');
    $('fileInfo').textContent = '解码失败，换个文件试试';
  }
}

// ---------- 麦克风录音（与上传并列；复用 decode→pcmMono→转写链路） ----------
let mediaStream = null, mediaRec = null, recChunks = [], recTimer = null, recT0 = 0;

function pickRecMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  try {
    for (const m of cands) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  } catch (_) {}
  return '';
}

$('rec').onclick = async () => {
  if (mediaRec && mediaRec.state === 'recording') { stopRec(); return; }
  await startRec();
};

async function startRec() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    dlog('当前浏览器不支持录音（无 getUserMedia）', 'err');
    return;
  }
  if (!window.MediaRecorder) {
    dlog('当前浏览器不支持 MediaRecorder，无法录音', 'err');
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const n = (err && err.name) || '';
    const hint = n === 'NotAllowedError' ? '麦克风权限被拒绝，请在地址栏允许后重试'
      : n === 'NotFoundError' ? '未找到麦克风设备'
      : n === 'NotReadableError' ? '麦克风被占用或不可用'
      : ('无法访问麦克风：' + (err && err.message || err));
    dlog(hint, 'err');
    $('fileInfo').textContent = hint;
    return;
  }
  recChunks = [];
  try {
    const mime = pickRecMime();
    mediaRec = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
  } catch (err) {
    dlog('录音启动失败：' + (err && err.message || err), 'err');
    try { mediaStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    return;
  }
  mediaRec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRec.onstop = onRecStop;
  mediaRec.start();
  recT0 = Date.now();
  $('rec').textContent = '⏹ 停止';
  $('recTime').textContent = '录音中 0s';
  $('fileInfo').textContent = '录音中…';
  recTimer = setInterval(() => {
    $('recTime').textContent = '录音中 ' + ((Date.now() - recT0) / 1000).toFixed(0) + 's';
  }, 500);
  dlog('开始录音（再次点击停止）…');
}

function stopRec() {
  try { if (mediaRec && mediaRec.state === 'recording') mediaRec.stop(); } catch (_) {}
  try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch (_) {}
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  $('rec').textContent = '🎤 录音';
}

async function onRecStop() {
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  $('rec').textContent = '🎤 录音';
  const blob = new Blob(recChunks, { type: (mediaRec && mediaRec.mimeType) || 'audio/webm' });
  mediaRec = null; mediaStream = null;
  $('recTime').textContent = '';
  if (!blob.size) { dlog('录音为空，请重试', 'err'); return; }
  audioFile = { name: 'mic-' + new Date(recT0).toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.webm', size: blob.size };
  pcmMono = null; midiBlob = null;
  armFreshAudio(); // 新录音：废弃旧断点
  $('dl').disabled = true;
  if ($('playv2')) $('playv2').disabled = true;
  $('fileInfo').textContent = '麦克风录音 · 解码中…';
  dlog(`录音结束：${blob.size} 字节，解码中…`);
  try {
    const t0 = performance.now();
    const ab = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const buf = await ctx.decodeAudioData(ab);
    await ctx.close();
    sampleRate = buf.sampleRate;
    const n = buf.length, ch = buf.numberOfChannels;
    pcmMono = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) pcmMono[i] += d[i] / ch;
    }
    dlog(`录音解码完成：${n} 采样 / ${sampleRate}Hz / ${ch}声道→单声道，${(performance.now() - t0).toFixed(0)}ms`, 'ok');
    $('fileInfo').textContent = `麦克风录音 · ${(n / sampleRate).toFixed(1)}s`;
    if (!prefetching) $('go').disabled = false; // 同上，预下载中不提前启用
    if (!prefetching && !$('go').disabled) $('go').click(); else if (prefetching) autoGo = true; // 录音解码完成即自动转写
  } catch (err) {
    dlog('录音解码失败：' + (err && err.message || err), 'err');
    $('fileInfo').textContent = '录音解码失败，请重试';
  }
}

// ---------- OPFS 模型缓存（双权重；命中则秒开，否则下载并校验字节数） ----------
async function fetchOne(dir, spec) {
  try {
    const fh = await dir.getFileHandle(spec.name);
    const file = await fh.getFile();
    if (file.size === spec.size) {
      dlog(`OPFS 命中：${spec.name} ${(file.size / 1048576).toFixed(1)} MB（秒开）`, 'ok');
      return file;
    }
    dlog(`${spec.name} 缓存不完整（${file.size}/${spec.size}），重新下载…`, 'warn');
  } catch (_) { /* 无缓存，下载 */ }
  dlog(`下载 ${spec.name}（${(spec.size / 1048576).toFixed(1)} MB，${spec.urls.length}镜像首512KB竞速）…`);
  $('prog').style.display = 'block';
  const t0 = performance.now();
  // 与门户同一套公共竞速组件：双镜像同时下，最先攒够 512KB 者胜出，其余 abort；
  // onProgress 实时驱动进度条 + MB/速度（用户要求：大文件进度必须可见）。
  const { blob, url } = await CdnRace.raceDownload(spec.urls, {
    label: spec.name,
    threshold: 512 * 1024,
    onProgress: pct => {
      $('progBar').style.width = pct.toFixed(1) + '%';
      $('phase').textContent = `下载 ${spec.name}… ${pct.toFixed(0)}%（${(pct / 100 * spec.size / 1048576).toFixed(1)}/${(spec.size / 1048576).toFixed(1)} MB）`;
    },
    onLive: (() => { let n = 0; return text => { $('phase').textContent = text; if (n++ === 0) dlog(text, undefined, true); }; })(), // 日志治理：竞速中间速度行只动进度条，首行＋onFinal完成行进面板
    onFinal: text => dlog(text, 'ok'),
  });
  if (blob.size !== spec.size) throw new Error(`${spec.name} 字节数不对：${blob.size}/${spec.size}（来源 ${url}）`);
  const fh = await dir.getFileHandle(spec.name, { create: true });
  const w = await fh.createWritable();
  await blob.stream().pipeTo(w);
  dlog(`${spec.name} 已缓存 ← ${url}，${((performance.now() - t0) / 1000).toFixed(0)}s`, 'ok');
  return blob;
}
async function ensureModels() {
  if (typeof CdnRace === 'undefined') throw new Error('竞速组件 shared/cdn-race.js 未加载（清缓存硬刷新试试）');
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('audio_to_midi', { create: true });
  const out = {};
  for (const spec of MODEL_FILES) {
    const blob = await fetchOne(dir, spec);
    out[spec.key] = await blob.arrayBuffer();
  }
  return out;
}

// ---------- 断点续跑（ckpt 落 OPFS；写失败只 warn 不中断转写） ----------
const CKPT_META = 'ckpt-meta.json', CKPT_PCM = 'ckpt-pcm.raw';
let ckptInfo = null, resumeArmed = false, lastPcm44 = null, lastSr = 44100, goOrigText = '开始转写';
async function ckptDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('audio_to_midi', { create: true });
}
async function clearCkpt() {
  try {
    const dir = await ckptDir();
    await dir.removeEntry(CKPT_META).catch(() => {});
    await dir.removeEntry(CKPT_PCM).catch(() => {});
  } catch (_) {}
}
function armFreshAudio() { // 新音频（上传/录音）：废弃旧断点，按钮文案恢复
  resumeArmed = false; ckptInfo = null;
  try { $('go').textContent = goOrigText; } catch (_) {}
  clearCkpt();
}
// 主线程收到 worker 每波 ckpt：meta 必写；pcm 只在缺失/大小不对时写一次（同一任务内容不变）
async function saveCkpt(m) {
  try {
    const dir = await ckptDir();
    if (lastPcm44) {
      let needPcm = true;
      try {
        const f = await (await dir.getFileHandle(CKPT_PCM)).getFile();
        needPcm = (f.size !== lastPcm44.byteLength);
      } catch (_) { needPcm = true; }
      if (needPcm) {
        const w = await (await dir.getFileHandle(CKPT_PCM, { create: true })).createWritable();
        await w.write(lastPcm44);
        await w.close();
      }
    }
    const meta = { doneSeg: m.doneSeg, nSegTotal: m.nSegTotal, sampleRate: lastSr, outMode: m.outMode || 'piano', startPos: m.startPos, events: m.events, time: Date.now() };
    const mw = await (await dir.getFileHandle(CKPT_META, { create: true })).createWritable();
    await mw.write(JSON.stringify(meta));
    await mw.close();
  } catch (err) {
    dlog('断点存档失败（不中断转写）：' + (err && err.message || err), 'warn');
  }
}
// load 时检查未完成任务：有断点则面板提示，按钮临时改“继续转写”（仅无新音频时）
async function checkCkpt() {
  try {
    const dir = await ckptDir();
    const meta = JSON.parse(await (await (await dir.getFileHandle(CKPT_META)).getFile()).text());
    const pf = await (await dir.getFileHandle(CKPT_PCM)).getFile();
    if (meta && meta.doneSeg > 0 && pf.size > 0) {
      ckptInfo = meta;
      dlog(`检测到未完成任务（${meta.doneSeg}段/${meta.nSegTotal}段），点“开始转写”继续`, 'warn');
      const gb = $('go');
      if (gb && !pcmMono) { gb.textContent = '继续转写'; gb.disabled = false; resumeArmed = true; }
    }
  } catch (_) { /* 无断点，正常 */ }
}

// ---------- 转写 ----------
$('go').onclick = async () => {
  autoGo = false; // 本次已触发，清除挂起的自动转写
  // 断点续跑：无新音频但有断点时，直接读 ckpt 发 resume（不走 pickFile）
  if (resumeArmed && !pcmMono && ckptInfo) {
    $('go').disabled = true;
    $('prog').style.display = 'block';
    transcribing = true;
    if (!wakeLock) await lockScreen();
    try {
      const dir = await ckptDir();
      const meta = JSON.parse(await (await (await dir.getFileHandle(CKPT_META)).getFile()).text());
      const raw = await (await (await dir.getFileHandle(CKPT_PCM)).getFile()).arrayBuffer();
      const rp = new Float32Array(raw);
      lastPcm44 = rp.slice(); lastSr = meta.sampleRate || 44100; // rp.buffer 随 transfer 剥离，留拷贝供后续 ckpt
      let models = preloadedModels;
      preloadedModels = null;
      if (!models) models = await ensureModels();
      const w = getWorker();
      const outMode = meta.outMode || 'piano';
      if ($('outMode')) $('outMode').value = outMode;
      const msg = { type: 'transcribe', sampleRate: lastSr, outMode, resume: { pcm: rp, startPos: meta.startPos, events: meta.events, fromSeg: meta.doneSeg, outMode } };
      const transfer = [rp.buffer];
      transfer.push(models.scorer, models.attr);
      if (models.scorerFp16) transfer.push(models.scorerFp16);
      if (forceBackendOnce) { msg.forceBackend = forceBackendOnce; forceBackendOnce = null; }
      dlog(`断点续跑：从第${meta.doneSeg + 1}段起，共${meta.nSegTotal}段`);
      w.postMessage(msg, transfer);
    } catch (err) {
      dlog('续跑启动失败：' + (err && err.message || err), 'err');
      $('go').disabled = false;
      transcribing = false;
      await unlockScreen();
    }
    return;
  }
  if (!pcmMono) return;
  transcribing = true;
  if (!wakeLock) await lockScreen();
  resumeArmed = false; // 新转写起跑（旧断点已在选文件时废弃）
  $('go').disabled = true;
  $('prog').style.display = 'block';
  try {
    // 预下载命中则复用（transfer 会剥离 buffer，用后即弃；未命中则转写时再下载）
    let models = preloadedModels;
    preloadedModels = null;
    if (!models) models = await ensureModels();
    lastPcm44 = pcmMono; lastSr = sampleRate; // pcmMono 本体不 transfer（传的是拷贝），可直接引用供 ckpt
    const w = getWorker();
    const buf = pcmMono.slice().buffer; // 拷贝后 transfer（保留原数据可重跑）
    const msg = { type: 'transcribe', pcm: new Float32Array(buf), sampleRate };
    msg.outMode = ($('outMode') && $('outMode').value) || 'piano'; // 仅钢琴 / 多乐器分区
    if (forceBackendOnce) { msg.forceBackend = forceBackendOnce; forceBackendOnce = null; } // gpuLost 重跑：跳过后端探测直走 wasm
    const transfer = [buf];
    msg.models = models; // 90MB 经 transfer 零拷贝给 Worker（下次跑重新读 OPFS）
    transfer.push(models.scorer, models.attr);
    if (models.scorerFp16) transfer.push(models.scorerFp16); // 老预下载无此键时跳过（worker 回退 fp32）
    dlog(`送入 Worker：${pcmMono.length} 采样 @${sampleRate}Hz`);
    w.postMessage(msg, transfer);
  } catch (err) {
    dlog('启动失败：' + (err && err.message || err), 'err');
    $('go').disabled = false;
    transcribing = false;
    await unlockScreen();
  }
};

function onWorkerMsg(e) {
  const m = e.data;
  if (m.type === 'phase') {
    $('phase').textContent = m.text;
    $('progBar').style.width = Math.round(m.ratio * 100) + '%';
    if (!m.quiet) dlog(m.text, undefined, true); // quiet=true：只动进度条，不进面板（日志治理）
  } else if (m.type === 'log') {
    dlog('[worker] ' + m.text);
  } else if (m.type === 'warmupOk') {
    dlog('ort 预热就绪', 'ok');
  } else if (m.type === 'backend') {
    dlog(m.webgpu ? '后端：WebGPU 可用（阶段4将优先使用）' : '后端：无 WebGPU → 阶段4将回退 WASM 模式（慢 5–10 倍）', m.webgpu ? 'ok' : 'warn');
    $('buildStatus').textContent = `在线转写 · 权重 R2/OPFS（scorer 57MB + attr 3.4MB）· ${m.webgpu ? '本机支持 WebGPU' : '本机无 WebGPU，走 WASM（慢 5–10 倍）'}`;
  } else if (m.type === 'done') {
    finish(m);
  } else if (m.type === 'ckpt') {
    saveCkpt(m); // 断点存档（失败只 warn，函数内部处理，不中断转写）
  } else if (m.type === 'error') {
    dlog('转写失败：' + m.text, 'err');
    $('go').disabled = false;
    transcribing = false; // 断点保留，可点“继续转写”重试
    unlockScreen();
  } else if (m.type === 'gpuLost') {
    // ort 内部 GPU 崩溃走的是游离 promise（try/catch 抓不到），由 worker 的
    // unhandledrejection 转换而来。这里用已解码的 pcm 直接重跑 wasm，不用用户动手。
    dlog('WebGPU 崩溃（device lost），转 WASM 自动重跑…', 'warn');
    forceBackendOnce = 'wasm';
    $('go').disabled = false;
    $('go').click();
  }
}

function finish(m) {
  const d = m.diag;
  transcribing = false;
  unlockScreen();
  clearCkpt(); // 完成删断点（resume 跑完同样）
  resumeArmed = false; ckptInfo = null;
  try { $('go').textContent = goOrigText; } catch (_) {}
  midiBlob = new Blob([m.midi], { type: 'audio/midi' });
  $('dl').disabled = false;
  if ($('playv2')) $('playv2').disabled = false;
  $('go').disabled = false;
  $('phase').textContent = `完成：${m.notes.length} 个事件（模型输出，${($('outMode') && $('outMode').value) === 'multi' ? '多乐器' : '仅钢琴'}${m.extended ? '·延音已展开' : ''}）`;
  dlog(`耗时：重采样 ${d.msResample.toFixed(0)}ms / 推理 ${d.msInfer.toFixed(0)}ms / 共 ${(d.msTotal / 1000).toFixed(1)}s；${d.segments}段 / 后端 ${d.backend || '?'}`, 'ok');
  $('stats').innerHTML =
    `<span>事件 <b>${m.notes.length}</b></span>` +
    `<span>分段 <b>${d.segments}</b></span><span>后端 <b>${d.backend || '?'}</b></span><span>总耗时 <b>${(d.msTotal / 1000).toFixed(1)}s</b></span><span>模式 <b>${m.mode}</b></span>`;
  drawRoll(m.notes);
  dlog('MIDI 已就绪，可下载；卷帘预览已渲染', 'ok');
}

$('dl').onclick = () => {
  if (!midiBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(midiBlob);
  a.download = (audioFile ? audioFile.name.replace(/\.[^.]+$/, '') : 'transkun') + '.mid';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  dlog('已触发下载：' + a.download, 'ok');
};

// ---------- 在重制版中播放：OPFS 握手 → 跳转 v2（finish 后启用） ----------
$('playv2').onclick = async () => {
  if (!midiBlob) return;
  $('playv2').disabled = true;
  try {
    $('phase').textContent = '正在交接给重制版…';
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('audio_to_midi', { create: true });
    const bytes = await midiBlob.arrayBuffer();
    const fh = await dir.getFileHandle('handoff.mid', { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    const base = (audioFile && audioFile.name ? audioFile.name.replace(/\.[^.]+$/, '') : 'transkun');
    const name = '转写_' + base + '.mid';
    const jh = await dir.getFileHandle('handoff.json', { create: true });
    const jw = await jh.createWritable();
    await jw.write(JSON.stringify({ name, time: Date.now() }));
    await jw.close();
    dlog('已写入 OPFS 交接：' + name + '（' + bytes.byteLength + ' 字节），正在跳转…', 'ok');
    location.href = '../midi_player_v2/?from=transcribe';
  } catch (err) {
    dlog('交接失败：' + (err && err.message || err), 'err');
    $('phase').textContent = '';
    $('playv2').disabled = false;
  }
};

// ---------- 钢琴卷帘（pitch 21–108） ----------
function drawRoll(notes) {
  const cv = $('roll'), ctx = cv.getContext('2d');
  cv.style.display = 'block';
  $('rollHint').textContent = '钢琴卷帘预览（金色=音符，青色=踏板）。';
  const W = cv.width, H = cv.height;
  ctx.fillStyle = '#0a0d12'; ctx.fillRect(0, 0, W, H);
  const pit = notes.filter(n => n.pitch > 0);
  if (!pit.length) { ctx.fillStyle = '#8b949e'; ctx.fillText('无音符事件', 20, 20); return; }
  const tEnd = Math.max(...pit.map(n => n.end), 0.1);
  const x = t => 40 + (t / tEnd) * (W - 50);
  const y = p => H - 10 - ((p - 21) / 87) * (H - 20);
  ctx.strokeStyle = '#30363d'; ctx.fillStyle = '#8b949e'; ctx.font = '10px sans-serif';
  for (let p = 21; p <= 108; p += 12) {
    ctx.beginPath(); ctx.moveTo(40, y(p)); ctx.lineTo(W - 10, y(p)); ctx.stroke();
    ctx.fillText('C' + (Math.round(p / 12) - 1), 4, y(p) + 3);
  }
  for (const n of pit) {
    ctx.fillStyle = '#e8b64c';
    const h = Math.max(2, 87 / 88 * (H - 20) / 88 * 8);
    ctx.fillRect(x(n.start), y(n.pitch) - h / 2, Math.max(2, x(n.end) - x(n.start)), h);
  }
  ctx.fillStyle = '#2dd4bf';
  for (const n of notes.filter(n => n.pitch < 0)) ctx.fillRect(x(n.start), H - 8, Math.max(2, x(n.end) - x(n.start)), 4);
  ctx.fillStyle = '#8b949e';
  ctx.fillText('0s', 40, H - 1); ctx.fillText(tEnd.toFixed(1) + 's', W - 44, H - 1);
}

// ---------- 进页预下载：load 后台调用 ensureModels（复用 fetchOne 进度条 + phase + 竞速逻辑） ----------
let preloadedModels = null; // 预下载好的模型（ArrayBuffer），转写时优先复用
let autoGo = false; // 上传/录音解码完成后自动开始转写（预下载中则等其结束再触发）
let forceBackendOnce = null; // gpuLost 重跑一次性后端指定（worker 收到后跳过探测）
let prefetching = false; // 预下载进行中时 pickFile/onRecStop 不提前启用转写按钮，避免并行双下载
window.addEventListener('load', () => {
  prefetching = true;
  const goBtn = $('go');
  const origText = goBtn.textContent; // 原文案“开始转写”
  goBtn.disabled = true;
  goBtn.textContent = '准备模型…';
  dlog('页面加载完成，后台预下载模型…');
  // 版本自报：?v= 由部署工作流按内容哈希自动重写，此处运行时从 script src 回读（人不用记）。
  // load 回调里 currentScript 已失效，主走 querySelector 兜底；取不到则空字串，不炸。
  let appVer = '';
  try {
    const cs = document.currentScript;
    let src = (cs && cs.src) || '';
    if (!src) { const s = document.querySelector('script[src*="app.js"]'); src = (s && s.src) || ''; }
    appVer = src ? (new URL(src, location.href).search || '') : '';
  } catch (_) { appVer = ''; }
  dlog(`版本自报：app.js${appVer}（看不到这行=跑的旧代码，清缓存硬刷新）`);
  // 测试入口 ?sample=URL：一键载入公网/同源测试音频（复测计时、issue 复现用）。
  // 无参时“🧪 测试音频”按钮进默认样例；有参则自动下载解码并走自动转写（复用 pickFile）。
  const sampleUrl = new URLSearchParams(location.search).get('sample');
  if (sampleUrl) fetchSample(sampleUrl).catch(err => dlog('测试音频加载失败：' + (err && err.message || err), 'err'));
  ensureModels().then(models => {
    preloadedModels = models;
    dlog('模型预下载完成，转写可秒开', 'ok');
  }).catch(err => {
    // 预热失败不拦路：允许点“开始转写”时再试一次
    dlog('模型预下载失败，转写时将重试：' + (err && err.message || err), 'warn');
  }).finally(() => {
    prefetching = false;
    goBtn.textContent = origText;
    goBtn.disabled = !pcmMono; // 无解码音频仍保持禁用，有则恢复可用
    if (autoGo && pcmMono && !goBtn.disabled) { autoGo = false; goBtn.click(); } // 预下载期间上传的文件，补触发自动转写
    goOrigText = origText;
    checkCkpt(); // 有未完成任务则按钮变“继续转写”（仅无新音频时）
  });
});
