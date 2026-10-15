/* MWS 适配器 —— MIDI播放器V2
   壳(shell.js)与页面(app.js)之间的唯一桥梁，完全解耦：
   - getState/applyState：播放状态跨窗口中继（壳不理解字段含义）
   - onAssign：窗口编号/分片 → v2 键位切片(__MW_SLICE) + 静音(非 #1)
   - applyOffset：显示偏移 → drawScene 时间基准(__MW_OFFSET_MS)
   依赖：app.js 已注入且带 __MW_PATCHED 标记（CDN 回退时告警） */
(function () {
  'use strict';
  let ready = false;
  let notifyTimer = 0;
  let applyingNow = false;   // applyState 进行中（含 300ms 尾巴）：抑制回声广播
  let pending = null;        // 异步切歌期间挂起的对齐请求

  function MWS() { return window.__MWS; }
  function debounceNotify() {
    if (applyingNow) return;             // 该变更来自他窗同步 → 不回声
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => { if (!applyingNow && MWS()) MWS().notify(); }, 80);
  }

  /* ---------- 对 v2 全局函数打通知钩子（包装 window 属性，内部裸调用同样经过包装） ---------- */
  function wrap(name) {
    const orig = window[name];
    if (typeof orig !== 'function') { console.warn('[MWS-adapter] 缺少函数 ' + name); return; }
    window[name] = function () { const r = orig.apply(this, arguments); debounceNotify(); return r; };
  }

  /* ---------- 按秒跳转（照抄 doSeek 的基准重设，去掉鼠标事件） ---------- */
  function seekTo(sec) {
    if (typeof totalDuration === 'undefined' || !totalDuration) return;
    sec = Math.max(0, Math.min(totalDuration, sec));
    currentTime = sec;
    if (isPlaying) {
      playStartTime = audioCtx.currentTime - currentTime / playSpeed;
      nextNoteIndex = lowerBound(allNotes, currentTime);
      nextCCIndex = lowerBound(allCCs, currentTime);
    }
    updateProgress();
    const fallDur = 2.0 / fallSpeedMultiplier;
    const leftIdx = lowerBound(allNotes, currentTime - fallDur - maxNoteDuration);
    const rightIdx = lowerBound(allNotes, currentTime + fallDur);
    drawScene(allNotes, leftIdx, rightIdx, currentTime);
  }

  /* ---------- 状态快照 / 应用 ---------- */
  function getState() {
    const sel = document.getElementById('songSel');
    let timbre = null;
    try { timbre = (window.SoundfontLoader && SoundfontLoader.current) || null; } catch (e) {}
    return {
      playing: !!isPlaying,
      pos: currentTime || 0,
      speed: playSpeed || 1,
      song: sel ? sel.value : null,
      timbre: timbre
    };
  }
  function alignPos(d) {
    if (typeof d.speed === 'number' && Math.abs(playSpeed - d.speed) > 0.01) setSpeed(d.speed);
    if (typeof d.pos === 'number') {
      const thr = d.playing ? 0.35 : 0.01;   // 播放中放宽到 350ms，避免心跳对时抖动
      if (Math.abs((currentTime || 0) - d.pos) > thr) seekTo(d.pos);
    }
    if (d.playing && !isPlaying) startPlay();
    else if (!d.playing && isPlaying) pausePlay();
    if (d.timbre) {
      try {
        const cur = window.SoundfontLoader && SoundfontLoader.current;
        if (cur && d.timbre !== cur) _applyTimbre(d.timbre, { auto: false });
      } catch (e) {}
    }
  }
  function applyState(d) {
    if (!ready || !d) return;
    applyingNow = true;
    pending = d;
    try {
      const sel = document.getElementById('songSel');
      if (d.song && sel && sel.value && d.song !== sel.value) {
        _switchToSong(d.song);   // 异步：加载完成在 parseAndPlayMidi 包装里收口
        return;
      }
      pending = null;
      alignPos(d);
    } catch (e) { console.warn('[MWS-adapter] applyState', e); }
    finally { setTimeout(() => { applyingNow = false; }, 300); }   // 覆盖 wrapper 的 80ms debounce
  }

  /* ---------- 分片 / 静音 ---------- */
  function applyMute() {
    try {
      if (typeof masterGain === 'undefined' || !masterGain) return;
      const idx = MWS() ? MWS().assignment().index : 0;
      masterGain.gain.value = idx === 0 ? 1 : 0;   // 仅 #1 出声，避免多窗重音
    } catch (e) {}
  }
  function hideZoomSliders() {   // 分片铺满后，宽度缩放/偏移/版型三滑块失去意义
    for (const id of ['pianoWidthSlider', 'pianoOffsetSlider', 'keyboardPresetSlider']) {
      const el = document.getElementById(id);
      if (el && el.parentElement) el.parentElement.style.display = 'none';
    }
  }
  function onAssign(a) {
    if (a.slice) window.__MW_SLICE = { lo: a.slice.lo, hi: a.slice.hi };
    else window.__MW_SLICE = null;
    try { if (window.resizeCanvas) resizeCanvas(); } catch (e) {}
    applyMute();
    if (a.slice) hideZoomSliders();
  }

  /* ---------- 就绪轮询：等 app.js（fetch 内联注入，异步） ---------- */
  function boot() {
    if (ready) return;
    if (!window.togglePlay || !window.__MW_PATCHED) {
      if (window.togglePlay) console.warn('[MWS-adapter] app.js 为 CDN 回退版本，切片/偏移补丁缺失');
      return;
    }
    ready = true;
    if (!window.__MW_PATCHED) console.warn('[MWS-adapter] app.js 缺少 __MW_PATCHED，壳层补丁未生效');

    /* 通知钩子：一切本地状态变化 → 壳广播（壳在 applyState 期间会抑制回声） */
    ['togglePlay', 'startPlay', 'pausePlay', 'stopPlay', 'replayPlay', 'nextSong',
      'setSpeed', 'onSpeedChange', 'doSeek', 'onSongChange', '_switchToSong', 'onTimbreChange'
    ].forEach(wrap);

    /* 切歌加载完成的单点（覆盖切歌/冷启动/上传），挂起状态在此收口 */
    const origParse = window.parseAndPlayMidi;
    window.parseAndPlayMidi = function () {
      const r = origParse.apply(this, arguments);
      Promise.resolve(r).then(() => {
        if (pending && typeof pending === 'object') { const p = pending; pending = null;
          setTimeout(() => { try { alignPos(p); } catch (e) {} }, 60); }
      }).catch(() => {});
      debounceNotify();
      return r;
    };

    /* initAudio 后重申静音（幂等） */
    const origInit = window.initAudio;
    window.initAudio = function () { const r = origInit.apply(this, arguments); applyMute(); return r; };

    /* 音频时钟解锁：本窗口任意首次点击 */
    document.addEventListener('pointerdown', () => {
      try { if (ready && typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
    }, true);

    /* 注册适配器 */
    window.ShellAdapter = {
      getState: getState,
      applyState: applyState,
      domain: { lo: 21, hi: 109, label: '键' },
      onAssign: onAssign,
      applyOffset: ms => { window.__MW_OFFSET_MS = ms; }
    };
    if (MWS()) MWS().onAssign(onAssign);   // 壳早于适配器就绪：立即补一次当前分片
    /* 静音每秒重申：防 initAudio 首次调用早于包装时机导致 masterGain 恒为 1（四窗齐响） */
    setInterval(applyMute, 1000);
    console.log('[MWS-adapter] 就绪：v2 页已接入同步壳');
  }
  setInterval(boot, 120);
  boot();
})();
