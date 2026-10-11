import { readFileSync } from 'fs';
import vm from 'vm';
const frames = JSON.parse(readFileSync('/tmp/opencode/mel_clean.json', 'utf8')).frames;
const want = JSON.parse(readFileSync('/tmp/opencode/spec_clean.json', 'utf8')).spec;
const src = readFileSync('/sdcard/1011/audio_to_midi/worker.js', 'utf8');
const sandbox = { postMessage: () => {}, onmessage: null, importScripts: () => {}, console,
  Float64Array, Float32Array, Uint8Array, Array, Math, JSON };
sandbox.__F = frames;
sandbox.__OUT = (o) => { sandbox.__R = o; };
vm.createContext(sandbox);
vm.runInContext(src + `
;__OUT((() => {
  const out = [];
  for (let f = 0; f < 3; f++) {
    const re = new Float64Array(4096), im = new Float64Array(4096);
    for (let i = 0; i < 4096; i++) { re[i] = __F[f*4096+i] * HANN[i]; im[i] = 0; }
    fft(re, im);
    const row = [];
    for (let k = 0; k <= 2048; k++) row.push((re[k]*re[k] + im[k]*im[k]) / 4096);
    out.push(row);
  }
  return out;
})());`, sandbox);
const got = sandbox.__R;
let mx = 0, at = '';
for (let f = 0; f < 3; f++) for (let k = 0; k <= 2048; k++) {
  const d = Math.abs(got[f][k] - want[f*2049+k]);
  if (d > mx) { mx = d; at = 'f='+f+' k='+k+' got='+got[f][k]+' want='+want[f*2049+k]; }
}
console.log('maxDiff=' + mx.toExponential(3), at);
console.log(mx < 1e-9 ? 'PASS spec' : 'FAIL spec');
