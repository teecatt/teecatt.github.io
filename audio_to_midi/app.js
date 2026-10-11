/* 音频转 MIDI · 主线程：上传解码 / OPFS 模型缓存 / Worker 调度 / 卷帘预览 / 诊断
 * 权重：R2 双文件（scorer 57MB + attr 3.4MB），OPFS 缓存 + 字节数校验。
 *（测试音阶自检已删除；Viterbi 植入自检保留在 worker 供 node 测试用，不经 UI。）
 */
'use strict';

// ---- 权重地址（R2，OPFS 缓存 + 字节数校验）----
const MODEL_R2 = 'https://weights.down2.top';
const MODEL_R2_DIRECT = 'https://pub-b8d95e05900c4ad98bf1420adcda0148.r2.dev';
const MODEL_FILES = [
  { key: 'scorer', urls: [MODEL_R2 + '/transkun_scorer.onnx', MODEL_R2_DIRECT + '/transkun_scorer.onnx'], name: 'transkun_scorer.onnx', size: 57104274 },
  { key: 'attr', urls: [MODEL_R2 + '/transkun_attr.onnx', MODEL_R2_DIRECT + '/transkun_attr.onnx'], name: 'transkun_attr.onnx', size: 3427886 },
];

const $ = id => document.getElementById(id);
const diagBox = $('diag');
function dlog(text, cls) {
  if (diagBox.dataset.init !== '1') { diagBox.textContent = ''; diagBox.dataset.init = '1'; }
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = (cls === 'err' ? '✗ ' : cls === 'warn' ? '⚠ ' : '· ') + text;
  diagBox.appendChild(line);
  diagBox.scrollTop = diagBox.scrollHeight;
}

let audioFile = null, pcmMono = null, sampleRate = 0, midiBlob = null, worker = null;

function getWorker() {
  if (!worker) {
    worker = new Worker('./worker.js?v=2');
    worker.onmessage = onWorkerMsg;
    worker.onerror = e => dlog('Worker 错误：' + e.message, 'err');
    worker.postMessage({ type: 'probeBackend' });
  }
  return worker;
}

// ---------- 上传 ----------
const drop = $('drop'), fileInput = $('file');
drop.onclick = () => fileInput.click();
['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]); });
fileInput.onchange = () => { if (fileInput.files[0]) pickFile(fileInput.files[0]); };

async function pickFile(f) {
  audioFile = f; pcmMono = null; midiBlob = null;
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
    $('go').disabled = false;
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
    $('go').disabled = false;
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
    onLive: text => { $('phase').textContent = text; },
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

// ---------- 转写 ----------
$('go').onclick = async () => {
  if (!pcmMono) return;
  $('go').disabled = true;
  $('prog').style.display = 'block';
  try {
    const models = await ensureModels();
    const w = getWorker();
    const buf = pcmMono.slice().buffer; // 拷贝后 transfer（保留原数据可重跑）
    const msg = { type: 'transcribe', pcm: new Float32Array(buf), sampleRate };
    const transfer = [buf];
    msg.models = models; // 60MB 经 transfer 零拷贝给 Worker（下次跑重新读 OPFS）
    transfer.push(models.scorer, models.attr);
    dlog(`送入 Worker：${pcmMono.length} 采样 @${sampleRate}Hz`);
    w.postMessage(msg, transfer);
  } catch (err) {
    dlog('启动失败：' + (err && err.message || err), 'err');
    $('go').disabled = false;
  }
};

function onWorkerMsg(e) {
  const m = e.data;
  if (m.type === 'phase') {
    $('phase').textContent = m.text;
    $('progBar').style.width = Math.round(m.ratio * 100) + '%';
  } else if (m.type === 'log') {
    dlog('[worker] ' + m.text);
  } else if (m.type === 'backend') {
    dlog(m.webgpu ? '后端：WebGPU 可用（阶段4将优先使用）' : '后端：无 WebGPU → 阶段4将回退 WASM 模式（慢 5–10 倍）', m.webgpu ? 'ok' : 'warn');
    $('buildStatus').textContent = `在线转写 · 权重 R2/OPFS（scorer 57MB + attr 3.4MB）· ${m.webgpu ? '本机支持 WebGPU' : '本机无 WebGPU，走 WASM（慢 5–10 倍）'}`;
  } else if (m.type === 'done') {
    finish(m);
  } else if (m.type === 'error') {
    dlog('转写失败：' + m.text, 'err');
    $('go').disabled = false;
  }
}

function finish(m) {
  const d = m.diag;
  midiBlob = new Blob([m.midi], { type: 'audio/midi' });
  $('dl').disabled = false;
  if ($('playv2')) $('playv2').disabled = false;
  $('go').disabled = false;
  $('phase').textContent = `完成：${m.notes.length} 个事件（模型输出）`;
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
