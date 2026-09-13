/* ============================================================
 * 雅马哈 C7 纯算法钢琴音色（Yamaha C7 Piano）
 * 零采样、零依赖：用 Web Audio 实时合成接近《Rush E》原版明亮三角钢琴的质感。
 * 声学模拟要点：
 *  - 基频 + 6 组泛音，4/5/6 次谐波轻微失谐（1/2/3/4.01/5.02/6.03），模拟弦的非整数谐波
 *  - 高次泛音振幅递减（1/0.6/0.3/0.15/0.08/0.04）
 *  - 音头叠加 ~8ms 白噪声脉冲（琴槌敲击瞬态）
 *  - 包络：2ms 起音 → 80ms 指数衰减到 30% → 自然延音 → 释音
 *  - 音高越高延音越短；velocity 同时控制总增益与泛音/噪声比例
 * 对外接口：playPianoNote(freq,dur,vel) / playNote(midi,...) / playNoteByName('C5',...)
 * 应用内接口：init(ctx,dest) 复用宿主 AudioContext，active 供按键高亮读取
 * ========================================================== */
(function(global){
  'use strict';
  const HARM = [1, 2, 3, 4.01, 5.02, 6.03];      // 谐波频率比（含轻微失谐）
  const HG   = [1, 0.6, 0.3, 0.15, 0.08, 0.04];   // 谐波振幅递减
  const SEMI = {C:0, D:2, E:4, F:5, G:7, A:9, B:11};
  const A4 = 440;
  const freqOf = m => A4 * Math.pow(2, (m - 69) / 12);
  function midiOf(name){
    const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name);
    if(!m) return 60;
    let n = SEMI[m[1].toUpperCase()];
    if(m[2] === '#') n++; else if(m[2] === 'b') n--;
    return (parseInt(m[3], 10) + 1) * 12 + n;
  }
  const Y = {
    ctx: null, dest: null, active: new Map(), _noise: null, _voices: [],
    init(ctx, dest){ this.ctx = ctx; this.dest = dest || ctx.destination; },
    _ensure(){
      if(!this.ctx){ const AC = global.AudioContext || global.webkitAudioContext; this.ctx = new AC(); this.dest = this.ctx.destination; }
      return this.ctx;
    },
    // 共享一段白噪声缓冲，避免每个音符重复生成
    _noiseBuf(ctx){
      if(this._noise && this._noise.sampleRate === ctx.sampleRate) return this._noise;
      const n = Math.floor(ctx.sampleRate * 0.02), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
      for(let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      return (this._noise = b);
    },
    playPianoNote(frequency, duration, velocity, midi){
      const ctx = this._ensure(), t = ctx.currentTime;
      const v = Math.max(0.01, Math.min(1, velocity || 0.8));
      if(midi == null) midi = Math.round(69 + 12 * Math.log2(frequency / A4));
      const out = ctx.createGain(); out.connect(this.dest);
      const peak = 0.28 * v;
      // 高音短延音：以 C4 为基准，每高 24 个半音延音减半
      const base = Math.min(1.8, 3.4 * Math.pow(2, -(midi - 60) / 24));
      const sus = Math.max(0.12, Math.min(duration || base, base)), stop = t + sus + 0.08;
      const nodes = [];
      // 泛音叠加
      for(let i = 0; i < 6; i++){
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = frequency * HARM[i];
        const g = ctx.createGain(); g.gain.value = HG[i] * (0.5 + 0.5 * v); // 力度越大泛音越亮
        o.connect(g); g.connect(out); o.start(t); o.stop(stop); nodes.push(o, g);
      }
      // 琴槌敲击瞬态：白噪声 × 线性衰减窗
      const s = ctx.createBufferSource(); s.buffer = this._noiseBuf(ctx);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime((0.03 + 0.02 * v) * peak, t);
      ng.gain.linearRampToValueAtTime(0, t + 0.008);
      s.connect(ng); ng.connect(out); s.start(t); s.stop(t + 0.02); nodes.push(s, ng);
      // 钢琴式包络：极速起音 → 快速衰减 → 自然延音 → 释音
      const p = out.gain;
      p.setValueAtTime(0, t);
      p.linearRampToValueAtTime(peak, t + 0.002);
      p.exponentialRampToValueAtTime(peak * 0.3, t + 0.08);
      p.exponentialRampToValueAtTime(0.0008, stop);
      p.linearRampToValueAtTime(0, stop + 0.02);
      const voice = {midi: midi, nodes: nodes, out: out};
      s.onended = () => {
        try{ out.disconnect(); }catch(e){}
        const i = this._voices.indexOf(voice); if(i >= 0) this._voices.splice(i, 1);
        if(this.active.get(midi) === voice) this.active.delete(midi);
      };
      this._voices.push(voice); this.active.set(midi, voice);
      if(this._voices.length > 64) this._steal(); // 复音上限，超出抢占最旧
      return voice;
    },
    _steal(){
      const v = this._voices.shift(); if(!v) return;
      const t = this.ctx.currentTime;
      try{ v.out.gain.cancelScheduledValues(t); v.out.gain.setValueAtTime(v.out.gain.value, t); v.out.gain.linearRampToValueAtTime(0, t + 0.02); }catch(e){}
      try{ v.nodes.forEach(n => { if(n.stop) n.stop(t + 0.03); }); }catch(e){}
      if(this.active.get(v.midi) === v) this.active.delete(v.midi);
    },
    stopNote(midi){
      const v = this.active.get(midi); if(!v || !this.ctx) return;
      const t = this.ctx.currentTime;
      try{ v.out.gain.cancelScheduledValues(t); v.out.gain.setValueAtTime(v.out.gain.value, t); v.out.gain.linearRampToValueAtTime(0, t + 0.06); }catch(e){}
      try{ v.nodes.forEach(n => { if(n.stop) n.stop(t + 0.08); }); }catch(e){}
      this.active.delete(midi);
    },
    stopAll(){
      const t = this.ctx ? this.ctx.currentTime : 0;
      for(const v of this._voices){
        try{ v.out.gain.cancelScheduledValues(t); v.out.gain.setValueAtTime(v.out.gain.value, t); v.out.gain.linearRampToValueAtTime(0, t + 0.05); }catch(e){}
        try{ v.nodes.forEach(n => { if(n.stop) n.stop(t + 0.07); }); }catch(e){}
      }
      this._voices.length = 0; this.active.clear();
    },
    playNote(midi, velocity, duration){ return this.playPianoNote(freqOf(midi), duration, velocity, midi); },
    playNoteByName(name, velocity, duration){ return this.playNote(midiOf(name), velocity, duration); },
  };
  global.YamahaC7 = Y;
})(typeof window !== 'undefined' ? window : this);
