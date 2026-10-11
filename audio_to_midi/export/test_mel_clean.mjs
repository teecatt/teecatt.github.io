import { readFileSync } from 'fs';
import vm from 'vm';
const truth = JSON.parse(readFileSync('/tmp/opencode/mel_clean.json', 'utf8'));
const src = readFileSync('/sdcard/1011/audio_to_midi/worker.js', 'utf8');
const srcV = readFileSync('/sdcard/1011/audio_to_midi/viterbi.js', 'utf8');
const sandbox = { postMessage: () => {}, onmessage: null, importScripts: () => {}, console,
  Float64Array, Float32Array, Uint8Array, Array, Math, JSON };
sandbox.__T = truth;
sandbox.__OUT = (o) => { sandbox.__R = o; };
vm.createContext(sandbox);
vm.runInContext(srcV + '\n' + src + `
;__OUT((() => {
  const fr = __T.frames, rows = [];
  for (let f = 0; f < 3; f++) {
    // 每帧独立测：只填该帧自己的 stride 区，避免帧间交叠覆盖
    const flat = new Float32Array(f*1024 + 4096);
    for (let i = 0; i < 4096; i++) flat[f*1024+i] = fr[f*4096+i];
    const mel = framesToMel(flat, f + 1);
    rows.push(Array.from(mel.slice(f*229, f*229+229)));
  }
  return rows;
})());`, sandbox);
const got = sandbox.__R, want = truth.mel;
let mx = 0, at = '';
for (let f = 0; f < 3; f++) for (let m = 0; m < 229; m++) {
  const d = Math.abs(got[f][m] - want[f*229+m]);
  if (d > mx) { mx = d; at = 'f='+f+' m='+m+' got='+got[f][m]+' want='+want[f*229+m]; }
}
console.log('maxDiff=' + mx.toExponential(3), at);
console.log(mx < 1e-5 ? "PASS mel-clean" : "FAIL mel-clean");
