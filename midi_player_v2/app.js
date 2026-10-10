/* MIDI 播放器_重制版 · 渲染引擎基于 spessasynth_lib (Apache-2.0, by spessasus)
 * 音色库 GeneralUser GS by S. Christian Collins · 与现版 midi_player/ 完全独立 */
import { WorkletSynthesizer, Sequencer } from "spessasynth_lib";

const V1_BASE = "../midi_player/";
const SF_URL = "./soundfonts/GeneralUserGS.sf3";
const KB_CH = 15;      // 键盘独占通道（避开歌曲常用通道）
const DRUM_CH = 9;
const VOICE_CAP = 384; // 高复音上限，Rush E 级密度
const $ = (id) => document.getElementById(id);

const GM_NAMES = ["Acoustic Grand Piano","Bright Acoustic Piano","Electric Grand Piano","Honky-tonk Piano","Electric Piano 1","Electric Piano 2","Harpsichord","Clavinet","Celesta","Glockenspiel","Music Box","Vibraphone","Marimba","Xylophone","Tubular Bells","Dulcimer","Drawbar Organ","Percussive Organ","Rock Organ","Church Organ","Reed Organ","Accordion","Harmonica","Tango Accordion","Acoustic Guitar (nylon)","Acoustic Guitar (steel)","Electric Guitar (jazz)","Electric Guitar (clean)","Electric Guitar (muted)","Overdriven Guitar","Distortion Guitar","Guitar harmonics","Acoustic Bass","Electric Bass (finger)","Electric Bass (pick)","Fretless Bass","Slap Bass 1","Slap Bass 2","Synth Bass 1","Synth Bass 2","Violin","Viola","Cello","Contrabass","Tremolo Strings","Pizzicato Strings","Orchestral Harp","Timpani","String Ensemble 1","String Ensemble 2","SynthStrings 1","SynthStrings 2","Choir Aahs","Voice Oohs","Synth Voice","Orchestra Hit","Trumpet","Trombone","Tuba","Muted Trumpet","French Horn","Brass Section","SynthBrass 1","SynthBrass 2","Soprano Sax","Alto Sax","Tenor Sax","Baritone Sax","Oboe","English Horn","Bassoon","Clarinet","Piccolo","Flute","Recorder","Pan Flute","Blown Bottle","Shakuhachi","Whistle","Ocarina","Lead 1 (square)","Lead 2 (sawtooth)","Lead 3 (calliope)","Lead 4 (chiff)","Lead 5 (charang)","Lead 6 (voice)","Lead 7 (fifths)","Lead 8 (bass+lead)","Pad 1 (new age)","Pad 2 (warm)","Pad 3 (polysynth)","Pad 4 (choir)","Pad 5 (bowed)","Pad 6 (metallic)","Pad 7 (halo)","Pad 8 (sweep)","FX 1 (rain)","FX 2 (soundtrack)","FX 3 (crystal)","FX 4 (atmosphere)","FX 5 (brightness)","FX 6 (goblins)","FX 7 (echoes)","FX 8 (sci-fi)","Sitar","Banjo","Shamisen","Koto","Kalimba","Bag pipe","Fiddle","Shanai","Tinkle Bell","Agogo","Steel Drums","Woodblock","Taiko Drum","Melodic Tom","Synth Drum","Reverse Cymbal","Guitar Fret Noise","Breath Noise","Seashore","Bird Tweet","Telephone Ring","Helicopter","Applause","Gunshot"];

let ctx = null, synth = null, seq = null, master = null, analyser = null, vizData = null;
let ready = false, playing = false, scrubbing = false;
let songs = [];      // {name, file} 现版谱面
let uploads = [];    // {name, data:ArrayBuffer} 本地上传
let curKey = null;   // "s:idx" / "u:idx"
let loopMode = "list";
let progOverride = -1; // -1 跟随 MIDI，否则强制该 program
let lastRate = 1;
const holdCount = new Map(); // midi -> 按住计数（歌曲+键盘叠加高亮）
const chanProg = new Array(16).fill(-1);

function setStatus(msg, isErr) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("err", !!isErr);
}
function log(tag, msg) {
  const line = "[AudioDebug][" + tag + "] " + msg;
  try { console.log(line); } catch (e) {}
  try {
    if (typeof window !== "undefined" && window.V2 && window.V2.pushLog) window.V2.pushLog(line);
  } catch (e) {}
}
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return m + ":" + String(ss).padStart(2, "0");
}
function fmtSize(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + "MB";
  return (n / 1024).toFixed(0) + "KB";
}

// ===== 带进度的下载（tag 非空时记调试日志，对齐现版谱面下载逻辑）=====
async function fetchBytes(url, onp, tag) {
  const t0 = performance.now();
  const r = await fetch(url, { cache: "force-cache" });
  if (!r.ok) throw new Error("下载失败 " + r.status + " " + url);
  const total = parseInt(r.headers.get("content-length") || "0", 10);
  if (tag) log("INFO", tag + " 开始下载" + (total ? "（" + fmtSize(total) + "）" : ""));
  if (!r.body || !r.body.getReader()) {
    const ab = await r.arrayBuffer();
    if (onp) onp(ab.byteLength, ab.byteLength);
    if (tag) log("INFO", tag + " 下载完成 " + fmtSize(ab.byteLength));
    return ab;
  }
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0, nextMark = 25;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onp) onp(got, total);
    if (tag && total > 0) {
      const pct = got / total * 100;
      if (pct >= nextMark) {
        log("INFO", tag + " 下载 " + pct.toFixed(0) + "%（" + fmtSize(got) + "/" + fmtSize(total) + "）");
        nextMark += 25;
      }
    }
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  if (tag) log("INFO", tag + " 下载完成 " + fmtSize(got) + "，用时 " + ((performance.now() - t0) / 1000).toFixed(1) + "s");
  return out.buffer;
}
function looksLikeMidi(ab) {
  if (!ab || ab.byteLength < 4) return false;
  const b = new Uint8Array(ab, 0, 4);
  return b[0] === 0x4d && b[1] === 0x54 && b[2] === 0x68 && b[3] === 0x64;
}
// ===== brotli 解压：原生优先，否则复用现版 wasm =====
let _brMod = null, _brLoading = null;
async function decompressBrotli(ab) {
  try {
    if (typeof DecompressionStream === "function") {
      new DecompressionStream("brotli");
      const ds = new DecompressionStream("brotli");
      const w = ds.writable.getWriter();
      const wp = w.write(new Uint8Array(ab)).then(() => w.close());
      const rd = ds.readable.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const r = await rd.read();
        if (r.done) break;
        chunks.push(r.value); total += r.value.length;
      }
      await wp;
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out.buffer;
    }
  } catch (e) { /* 走 WASM */ }
  if (!_brMod) {
    if (!_brLoading) {
      _brLoading = (async () => {
        const mod = await import(V1_BASE + "vendor/brotli_dec_wasm.js");
        const wab = await (await fetch(V1_BASE + "vendor/brotli_dec_wasm_bg.wasm")).arrayBuffer();
        await mod.default({ module_or_path: wab });
        _brMod = mod;
        return mod;
      })();
    }
    await _brLoading;
  }
  const out = _brMod.decompress(new Uint8Array(ab));
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

// ===== 引擎初始化（用户手势内调用）=====
async function initEngine() {
  if (ready || initEngine._run) return;
  initEngine._run = true;
  const btn = $("initBtn");
  btn.disabled = true;
  try {
    setStatus("创建音频上下文…");
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: "playback" });
    if (ctx.state === "suspended") await ctx.resume();
    log("INFO", "AudioContext @" + ctx.sampleRate + "Hz，状态 " + ctx.state);
    setStatus("注册合成 worklet…");
    await ctx.audioWorklet.addModule("./vendor/spessasynth_processor.min.js");
    log("INFO", "合成 worklet 注册成功");
    synth = new WorkletSynthesizer(ctx);
    master = ctx.createGain();
    master.gain.value = $("volSlider").value / 100;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    vizData = new Uint8Array(analyser.frequencyBinCount);
    synth.connect(master);
    master.connect(analyser);
    analyser.connect(ctx.destination);
    synth.setSystemParameter("voiceCap", VOICE_CAP);
    synth.setSystemParameter("reverbGain", $("revSlider").value / 100);
    synth.setSystemParameter("chorusGain", $("choSlider").value / 100);
    synth.eventHandler.timeDelay = 0;
    setStatus("下载音色库 GeneralUser GS (8MB)…");
    const sfb = await fetchBytes(SF_URL, (got, total) => {
      $("initProg").style.width = total ? (got / total * 100).toFixed(1) + "%" : "50%";
      setStatus("下载音色库 " + fmtSize(got) + (total ? " / " + fmtSize(total) : "…"));
    }, "音色库[GeneralUserGS.sf3]");
    setStatus("解析音色库（vorbis 解码，稍候）…");
    await synth.soundBankManager.addSoundBank(sfb, "main");
    await synth.isReady;
    log("INFO", "音色库就绪，预设 " + synth.presetList.length + " 个");
    buildProgramSelect();
    seq = new Sequencer(synth, { skipToFirstNoteOn: true });
    seq.playbackRate = lastRate;
    applyLoopMode();
    wireEvents();
    // 键盘通道音色
    synth.programChange(KB_CH, progOverride >= 0 ? progOverride : 0);
    ready = true;
    $("initBox").style.display = "none";
    $("playerUI").style.display = "";
    setStatus("就绪 · " + synth.presetList.length + " 个预设 · 复音上限 " + VOICE_CAP);
    await loadSongList();
    requestAnimationFrame(tick);
  } catch (e) {
    console.error(e);
    setStatus("初始化失败：" + (e && e.message || e), true);
    btn.disabled = false;
    initEngine._run = false;
  }
}

function buildProgramSelect() {
  const sel = $("progSel");
  const bankNames = {};
  try {
    for (const p of synth.presetList) {
      if (p && p.bank === 0 && !(p.program in bankNames) && p.name) bankNames[p.program] = p.name;
    }
  } catch (e) { /* 用 GM 默认名 */ }
  let html = '<option value="-1">跟随 MIDI 自带音色</option>';
  for (let i = 0; i < 128; i++) {
    const nm = bankNames[i] || GM_NAMES[i];
    html += '<option value="' + i + '"' + (i === 0 ? " selected" : "") + ">" + i + ": " + nm + "</option>";
  }
  sel.innerHTML = html;
  sel.value = "-1";
  progOverride = -1;
}

function wireEvents() {
  synth.eventHandler.addEvent("noteOn", "v2hl", (d) => {
    const c = holdCount.get(d.midiNote) || 0;
    holdCount.set(d.midiNote, c + 1);
    const k = keyEls.get(d.midiNote);
    if (k) k.classList.add("on");
  });
  synth.eventHandler.addEvent("noteOff", "v2hl", (d) => {
    const c = (holdCount.get(d.midiNote) || 1) - 1;
    if (c <= 0) {
      holdCount.delete(d.midiNote);
      const k = keyEls.get(d.midiNote);
      if (k) k.classList.remove("on");
    } else holdCount.set(d.midiNote, c);
  });
  synth.eventHandler.addEvent("stopAll", "v2hl", () => {
    holdCount.clear();
    for (const k of keyEls.values()) k.classList.remove("on");
  });
  synth.eventHandler.addEvent("programChange", "v2ovr", (d) => {
    if (d.channel != null && d.channel >= 0 && d.channel < 16) chanProg[d.channel] = d.program;
    // 强制音色模式：把 MIDI 内 program 事件改写回去（鼓/键盘通道除外）
    if (progOverride >= 0 && d.channel !== DRUM_CH && d.channel !== KB_CH && d.program !== progOverride) {
      try { synth.programChange(d.channel, progOverride); } catch (e) {}
    }
    refreshChanInfo();
  });
  seq.eventHandler.addEvent("songChange", "v2sc", (data) => {
    chanProg.fill(-1);
    try {
      for (let ch = 0; ch < 16; ch++) {
        const p = synth.midiChannels[ch] && synth.midiChannels[ch].patch;
        if (p && p.program != null) chanProg[ch] = p.program;
      }
    } catch (e) {}
    applyProgOverride();
    refreshChanInfo();
    updateSongLabel();
    try {
      log("INFO", "谱面就绪 " + (data && data.fileName || "") + " · 时长 " + fmtTime(seq.duration) +
        (data && data.tracks ? " · " + data.tracks.length + " 轨" : ""));
    } catch (e) {}
  });
  seq.eventHandler.addEvent("songEnded", "v2se", () => {
    if (loopMode === "list") {
      stepSong(1, true);
    } else {
      playing = false;
      updatePlayBtn();
    }
  });
}

// ===== 谱面 =====
async function loadSongList() {
  const sel = $("songSel");
  try {
    const list = await (await fetch(V1_BASE + "midi/list.json", { cache: "force-cache" })).json();
    songs = list.filter((e) => e && e.file && !e.test);
  } catch (e) {
    songs = [];
  }
  renderSongOptions();
  if (songs.length) {
    sel.value = "s:0";
    await loadSongByKey("s:0", true);
  }
}
function renderSongOptions() {
  const sel = $("songSel");
  let html = "";
  songs.forEach((s, i) => { html += '<option value="s:' + i + '">' + s.name + "</option>"; });
  uploads.forEach((u, i) => { html += '<option value="u:' + i + '">[本地] ' + u.name + "</option>"; });
  sel.innerHTML = html || '<option value="">（无谱面）</option>';
  if (curKey) sel.value = curKey;
}
function resolveEntry(key) {
  if (key.startsWith("u:")) {
    const u = uploads[parseInt(key.slice(2), 10)];
    return u ? { name: u.name, data: u.data } : null;
  }
  const s = songs[parseInt(key.slice(2), 10)];
  return s ? { name: s.name, file: s.file } : null;
}
async function loadSongByKey(key, autoplay) {
  const entry = resolveEntry(key);
  if (!entry) return;
  curKey = key;
  $("songSel").value = key;
  seq.pause();
  try { synth.stopAll(true); } catch (e) {}
  playing = false;
  updatePlayBtn();
  holdCount.clear();
  try {
    let bytes;
    if (entry.data) {
      bytes = entry.data;
      setStatus("载入本地谱面 " + entry.name + "…");
    } else {
      setStatus("下载谱面 " + entry.name + "…");
      const ab = await fetchBytes(V1_BASE + entry.file + ".br", (got, total) => {
        setStatus("下载谱面 " + fmtSize(got) + (total ? " / " + fmtSize(total) : "…"));
      }, "谱面[" + entry.name + "]");
      if (looksLikeMidi(ab)) {
        log("INFO", "谱面[" + entry.name + "] 服务端已解压，直接使用");
        bytes = ab;
      } else {
        setStatus("解压谱面…");
        bytes = await decompressBrotli(ab);
        if (!looksLikeMidi(bytes)) throw new Error("谱面数据不是有效 MIDI");
        log("INFO", "谱面[" + entry.name + "] br 解压 " + fmtSize(ab.byteLength) + " -> " + fmtSize(bytes.byteLength) +
          "（压缩比 " + (bytes.byteLength / ab.byteLength).toFixed(1) + "x）");
      }
    }
    seq.loadNewSongList([{ binary: bytes, fileName: entry.name }]);
    setStatus("已载入 " + entry.name + " · " + fmtTime(seq.duration));
    updateSongLabel();
    if (autoplay) {
      await ctx.resume();
      seq.play();
      playing = true;
      updatePlayBtn();
    }
  } catch (e) {
    console.error(e);
    setStatus("载入失败：" + (e && e.message || e), true);
  }
}
function stepSong(dir, autoplay) {
  // 播放列表 = 现版谱面 + 本地上传
  const total = songs.length + uploads.length;
  if (!total) return;
  const order = [];
  songs.forEach((_, i) => order.push("s:" + i));
  uploads.forEach((_, i) => order.push("u:" + i));
  let idx = order.indexOf(curKey);
  idx = idx < 0 ? (dir > 0 ? 0 : total - 1) : (idx + dir + total) % total;
  loadSongByKey(order[idx], autoplay);
}
function updateSongLabel() {
  $("songName").textContent = curKey ? (resolveEntry(curKey) || {}).name || "-" : "-";
  $("durLabel").textContent = "/ " + fmtTime(seq ? seq.duration : 0);
}
function applyProgOverride() {
  if (!synth || progOverride < 0) return;
  for (let ch = 0; ch < 16; ch++) {
    if (ch === DRUM_CH || ch === KB_CH) continue;
    try { synth.programChange(ch, progOverride); } catch (e) {}
  }
}
function refreshChanInfo() {
  const parts = [];
  for (let ch = 0; ch < 16; ch++) {
    const p = chanProg[ch];
    if (p >= 0) parts.push("CH" + ch + ":" + (GM_NAMES[p] || ("#" + p)));
  }
  $("chanInfo").textContent = parts.length ? parts.join(" · ") : "（通道音色随播放出现）";
}

// ===== 走带控制 =====
function updatePlayBtn() {
  $("playBtn").textContent = playing ? "⏸ 暂停" : "▶ 播放";
}
async function togglePlay() {
  if (!ready || !seq) return;
  if (playing) {
    seq.pause();
    playing = false;
  } else {
    await ctx.resume();
    seq.play();
    playing = true;
  }
  updatePlayBtn();
}
function stopPlay() {
  if (!seq) return;
  seq.pause();
  try { seq.currentTime = 0; } catch (e) {}
  try { synth.stopAll(true); } catch (e) {}
  playing = false;
  updatePlayBtn();
}
function applyLoopMode() {
  if (!seq) return;
  seq.loopCount = loopMode === "one" ? -1 : 0;
}

// ===== 键盘 =====
const keyEls = new Map();
function isBlack(m) {
  return [1, 3, 6, 8, 10].includes(m % 12);
}
function buildKeyboard() {
  const wrap = $("kb");
  wrap.innerHTML = "";
  keyEls.clear();
  const whites = document.createElement("div");
  whites.className = "kb-whites";
  const blacks = document.createElement("div");
  blacks.className = "kb-blacks";
  for (let m = 21; m <= 108; m++) {
    const k = document.createElement("div");
    k.dataset.midi = m;
    if (isBlack(m)) {
      k.className = "kb-black";
      blacks.appendChild(k);
    } else {
      k.className = "kb-white";
      if (m % 12 === 0) {
        const lb = document.createElement("span");
        lb.className = "kb-label";
        lb.textContent = "C" + (Math.floor(m / 12) - 1);
        k.appendChild(lb);
      }
      whites.appendChild(k);
    }
    keyEls.set(m, k);
    bindKey(k, m);
  }
  wrap.appendChild(whites);
  wrap.appendChild(blacks);
  layoutBlacks();
}
function layoutBlacks() {
  // 黑键定位到其右侧白键左侧缝
  const blacks = $("kb").querySelectorAll(".kb-black");
  blacks.forEach((el) => {
    const m = parseInt(el.dataset.midi, 10);
    const nextWhite = keyEls.get(m + 1);
    if (!nextWhite) { el.style.display = "none"; return; }
    el.style.display = "";
    const wrapBox = $("kb").getBoundingClientRect();
    const wb = nextWhite.getBoundingClientRect();
    el.style.left = wb.left - wrapBox.left + "px";
  });
}
function bindKey(el, midi) {
  const down = (e) => {
    e.preventDefault();
    if (!ready) return;
    try {
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      ctx.resume();
      synth.noteOn(KB_CH, midi, 96);
    } catch (err) {}
  };
  const up = (e) => {
    e.preventDefault();
    if (!ready) return;
    try { synth.noteOff(KB_CH, midi); } catch (err) {}
  };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

// ===== 可视化 + 状态轮询 =====
let vizCtx = null, lastChanRefresh = 0;
function tick() {
  if (!ready) return;
  try {
    if (!scrubbing && seq && seq.duration > 0) {
      $("prog").value = Math.floor(seq.currentTime / seq.duration * 1000);
      $("timeLabel").textContent = fmtTime(seq.currentTime);
    }
    $("tempoLabel").textContent = seq ? Math.round(seq.currentTempo) + " BPM" : "-";
    $("voiceLabel").textContent = synth ? synth.voiceCount + " voices" : "-";
    const now = performance.now();
    if (now - lastChanRefresh > 800) {
      lastChanRefresh = now;
      // 用发声数>0 的通道补全音色显示
      let changed = false;
      for (let ch = 0; ch < 16; ch++) {
        try {
          const mc = synth.midiChannels[ch];
          if (mc && mc.voiceCount > 0 && mc.patch && mc.patch.program != null && chanProg[ch] !== mc.patch.program) {
            chanProg[ch] = mc.patch.program;
            changed = true;
          }
        } catch (e) {}
      }
      if (changed) refreshChanInfo();
    }
    // 频谱
    if (!vizCtx) vizCtx = $("viz").getContext("2d");
    analyser.getByteFrequencyData(vizData);
    const c = vizCtx, W = $("viz").width, H = $("viz").height;
    c.clearRect(0, 0, W, H);
    const N = 48, bw = W / N;
    for (let i = 0; i < N; i++) {
      const v = vizData[Math.floor(i / N * vizData.length * 0.72)] / 255;
      const h = Math.max(2, v * H);
      c.fillStyle = "rgba(139,92,246," + (0.35 + v * 0.6).toFixed(2) + ")";
      c.fillRect(i * bw + 1, H - h, bw - 2, h);
    }
  } catch (e) { /* 忽略单帧错误 */ }
  requestAnimationFrame(tick);
}

// ===== 事件绑定 + 自动启动（对齐现版：进页面立即开始下载）=====
// 无手势时 AudioContext 为 suspended：下载/解析照常进行，首次交互时解锁声音
function ensureCtx() {
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}
if (typeof window !== "undefined") {
  ["pointerdown", "keydown", "touchend"].forEach((ev) =>
    window.addEventListener(ev, ensureCtx, { passive: true }));
  if (window.V2) window.V2.init = initEngine;
}
window.addEventListener("DOMContentLoaded", () => {
  buildKeyboard();
  window.addEventListener("resize", layoutBlacks);
  $("playBtn").addEventListener("click", togglePlay);
  $("stopBtn").addEventListener("click", stopPlay);
  $("prevBtn").addEventListener("click", () => stepSong(-1, playing));
  $("nextBtn").addEventListener("click", () => stepSong(1, playing));
  $("songSel").addEventListener("change", (e) => loadSongByKey(e.target.value, true));
  $("loopSel").addEventListener("change", (e) => { loopMode = e.target.value; applyLoopMode(); });
  $("rateSel").addEventListener("change", (e) => {
    lastRate = parseFloat(e.target.value);
    if (seq) seq.playbackRate = lastRate;
  });
  $("prog").addEventListener("input", () => {
    scrubbing = true;
    if (seq && seq.duration > 0) $("timeLabel").textContent = fmtTime($("prog").value / 1000 * seq.duration);
  });
  $("prog").addEventListener("change", () => {
    scrubbing = false;
    if (seq && seq.duration > 0) {
      try { seq.currentTime = $("prog").value / 1000 * seq.duration; } catch (e) {}
    }
  });
  $("progSel").addEventListener("change", (e) => {
    progOverride = parseInt(e.target.value, 10);
    if (!ready) return;
    try { synth.programChange(KB_CH, progOverride >= 0 ? progOverride : 0); } catch (err) {}
    applyProgOverride();
  });
  $("volSlider").addEventListener("input", (e) => {
    $("volVal").textContent = e.target.value + "%";
    if (master) master.gain.value = e.target.value / 100;
  });
  $("revSlider").addEventListener("input", (e) => {
    $("revVal").textContent = e.target.value + "%";
    if (synth) synth.setSystemParameter("reverbGain", e.target.value / 100);
  });
  $("choSlider").addEventListener("input", (e) => {
    $("choVal").textContent = e.target.value + "%";
    if (synth) synth.setSystemParameter("chorusGain", e.target.value / 100);
  });
  $("fxToggle").addEventListener("change", (e) => {
    if (synth) synth.setSystemParameter("effectsEnabled", e.target.checked);
  });
  $("uploadBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) await addUpload(f);
  });
  const dz = $("dropzone");
  ["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", async (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) await addUpload(f);
  });
  // brotli 支持性（对齐现版日志口径）
  let nativeBr = false;
  try { if (typeof DecompressionStream === "function") { new DecompressionStream("brotli"); nativeBr = true; } } catch (e) {}
  log("INFO", "brotli 支持性：" + (nativeBr ? "浏览器原生支持" : "需 WASM（复用现版解码器）"));
  // 进页面立即自动初始化 + 下载（现版同样逻辑）
  log("INFO", "页面载入，自动开始初始化");
  initEngine();
});
async function addUpload(file) {
  try {
    const ab = await file.arrayBuffer();
    if (!looksLikeMidi(ab)) {
      setStatus("不是有效 MIDI 文件：" + file.name, true);
      return;
    }
    uploads.push({ name: file.name, data: ab });
    renderSongOptions();
    await loadSongByKey("u:" + (uploads.length - 1), true);
  } catch (e) {
    setStatus("读取失败：" + (e && e.message || e), true);
  }
}
