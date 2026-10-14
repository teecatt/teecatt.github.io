/* 多窗口 MIDI 同步 —— 纯逻辑层（无 DOM，可在 node 中直接单测）
   包含：SMF(MIDI) 解析、内置 88 键演示谱、88 键均分切片、音名工具 */
(function (global) {
  'use strict';

  const KEY_LO = 21;   // A0
  const KEY_HI = 108;  // C8
  const KEY_COUNT = 88;

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function noteName(n) {
    return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
  }

  function isBlackKey(n) {
    const m = ((n % 12) + 12) % 12;
    return m === 1 || m === 3 || m === 6 || m === 8 || m === 10;
  }

  /* 88 键按窗口序号均分：窗口 k(0 基)/共 N 个 → [lo, hi) 的 MIDI 音号区间 */
  function sliceFor(k, n) {
    if (n < 1) n = 1;
    if (k < 0) k = 0;
    if (k >= n) k = n - 1;
    const lo = KEY_LO + Math.floor(KEY_COUNT * k / n);
    const hi = KEY_LO + Math.floor(KEY_COUNT * (k + 1) / n);
    return { lo, hi };
  }

  /* ---------- SMF 解析 ---------- */
  function parseMIDI(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    const total = dv.byteLength;
    if (total < 14 || dv.getUint32(0) !== 0x4d546864) throw new Error('不是有效的 MIDI 文件（缺 MThd）');
    const division = dv.getUint16(12);   // MThd(4)+len(4)+fmt(2)+ntrks(2) 后是 division
    if (division & 0x8000) throw new Error('暂不支持 SMPTE 时基的 MIDI');
    if (!division) throw new Error('MIDI 时基(PPQ)为 0');

    // 切出所有 MTrk 轨道块（容错：未知 chunk 按长度跳过）；头共 14 字节，轨道从 14 开始
    const tracks = [];
    let gp = 14;
    while (gp + 8 <= total) {
      const tag = dv.getUint32(gp);
      const tlen = dv.getUint32(gp + 4);
      const s = gp + 8;
      const e = Math.min(total, s + tlen);
      if (s > total) break;
      if (tag === 0x4d54726b) tracks.push({ s, e });
      gp = s + tlen;
    }
    if (!tracks.length) throw new Error('未找到音轨（缺 MTrk）');

    const tempos = [];    // {tick, us}
    const rawNotes = [];  // {t0, t1, note, vel}（tick 单位）

    for (const tr of tracks) {
      let p = tr.s;
      const end = tr.e;
      let status = 0, tick = 0, maxTick = 0;
      const onQueue = new Map(); // ch*128+note -> [{tick, vel}]

      const readVLQ = () => {
        let v = 0, b;
        do {
          if (p >= end) throw new Error('VLQ 越界');
          b = dv.getUint8(p++);
          v = (v << 7) | (b & 0x7f);
        } while (b & 0x80);
        return v;
      };

      try {
        while (p < end) {
          tick += readVLQ();
          if (tick > maxTick) maxTick = tick;
          let b = dv.getUint8(p);
          if (b >= 0x80) { status = b; p++; }

          if (status === 0xff) {                      // Meta
            const type = dv.getUint8(p++);
            const mlen = readVLQ();
            if (p + mlen > end) break;
            if (type === 0x51 && mlen === 3) {
              const us = (dv.getUint8(p) << 16) | (dv.getUint8(p + 1) << 8) | dv.getUint8(p + 2);
              tempos.push({ tick, us: us || 500000 });
            } else if (type === 0x2f) {               // End of Track
              p += mlen;
              break;
            }
            p += mlen;
            status = 0;                                // Meta 取消 running status
          } else if (status === 0xf0 || status === 0xf7) { // SysEx
            const slen = readVLQ();
            if (p + slen > end) break;
            p += slen;
            status = 0;
          } else if (status === 0) {                   // 无状态字节的裸数据：跳过容错
            p++;
          } else {                                     // Channel 消息 / running status
            const hi = status & 0xf0;
            const ch = status & 0x0f;
            const twoBytes = hi !== 0xc0 && hi !== 0xd0;
            if (p + (twoBytes ? 2 : 1) > end) break;
            const d1 = dv.getUint8(p++);
            const d2 = twoBytes ? dv.getUint8(p++) : 0;
            const key = ch * 128 + d1;
            if (hi === 0x90 && d2 > 0) {              // Note On
              let q = onQueue.get(key);
              if (!q) { q = []; onQueue.set(key, q); }
              q.push({ tick, vel: d2 });
            } else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) { // Note Off
              const q = onQueue.get(key);
              if (q && q.length) {
                const on = q.shift();
                rawNotes.push({ t0: on.tick, t1: Math.max(tick, on.tick), note: d1, vel: on.vel });
              }
            }
          }
        }
      } catch (e) { /* 单轨损坏则保留已解析部分 */ }

      // 未闭合的音符延长到该轨末尾
      for (const q of onQueue.values()) {
        for (const on of q) rawNotes.push({ t0: on.tick, t1: Math.max(maxTick, on.tick), note: on.note, vel: on.vel });
      }
    }

    if (!rawNotes.length) throw new Error('MIDI 中没有音符');

    // tempo map → tick 转秒
    tempos.sort((a, b) => a.tick - b.tick);
    const tickToSec = (target) => {
      let sec = 0, cur = 0, us = 500000;
      for (const t of tempos) {
        if (t.tick >= target) break;
        if (t.tick > cur) sec += (t.tick - cur) * us / (division * 1e6);
        cur = t.tick; us = t.us;
      }
      sec += (target - cur) * us / (division * 1e6);
      return sec;
    };

    const notes = rawNotes.map(r => {
      const t = tickToSec(r.t0);
      const t1 = tickToSec(r.t1);
      return { t, dur: Math.max(0.05, t1 - t), note: r.note, vel: r.vel };
    }).sort((a, b) => a.t - b.t);

    let duration = 0;
    for (const n of notes) duration = Math.max(duration, n.t + n.dur);
    return { name: '', notes, duration };
  }

  /* ---------- 内置演示谱：上下行扫过全部 88 键 ---------- */
  function buildDemoSong() {
    const notes = [];
    let t = 0;
    for (let n = KEY_LO; n <= KEY_HI; n++) {           // 上行
      notes.push({ t, dur: 0.42, note: n, vel: 70 + (n * 13) % 40 });
      t += 0.18;
    }
    for (let n = KEY_HI; n >= KEY_LO; n--) {           // 下行 + 低音
      notes.push({ t, dur: 0.4, note: n, vel: 60 + (n * 7) % 50 });
      if (n % 6 === 0) notes.push({ t, dur: 0.9, note: KEY_LO + (n * 5) % 24, vel: 55 });
      t += 0.18;
    }
    for (const n of [21, 33, 45, 57, 69, 81, 93, 105, 108]) { // 结尾扫奏和弦
      notes.push({ t, dur: 2.2, note: n, vel: 92 });
      t += 0.12;
    }
    t += 3;
    notes.sort((a, b) => a.t - b.t);
    return { name: '内置演示谱（88键全扫）', notes, duration: t };
  }

  const api = { KEY_LO, KEY_HI, KEY_COUNT, noteName, isBlackKey, sliceFor, parseMIDI, buildDemoSong };
  global.MidiCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
