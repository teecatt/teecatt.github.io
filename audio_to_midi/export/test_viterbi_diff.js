// node 对拍：viterbi.js vs torch 真值（/tmp/opencode/vit_truth.json）
const fs = require('fs');
const src = fs.readFileSync('/sdcard/1011/audio_to_midi/viterbi.js', 'utf8');
eval(src);
const V = globalThis.TranskunViterbi;
const cases = JSON.parse(fs.readFileSync('/tmp/opencode/vit_truth.json', 'utf8'));
let pass = 0, fail = 0, crashExpected = 0;
for (const c of cases) {
  for (let b = 0; b < 2; b++) {
    const S = c.score, N = c.noise, T = c.T, r = c.ref[b];
    const getScore = (e, g) => S[e][g][b];
    const getSkip = (t) => (N[t] ? N[t][b] : 0);
    if (r.path === null) { // torch 原版崩溃（T=1）：JS 应鲁棒返回
      const got = V.decode({ T, getScore, getSkip, forcedStart: r.fs });
      const ok = JSON.stringify(got) === JSON.stringify(S[0][0][b] > 0 ? [[0, 0]] : []);
      ok ? crashExpected++ : fail++;
      if (!ok) console.log('ROBUST-FAIL', T, got);
      continue;
    }
    const got = V.decode({ T, getScore, getSkip, forcedStart: r.fs });
    const samePath = JSON.stringify(got) === JSON.stringify(r.path);
    const ps = V.pathScore({ T, intervals: got, getScore, getSkip });
    const sameScore = Math.abs(ps - r.score) < 1e-4;
    if (samePath && sameScore) pass++;
    else { fail++; console.log('FAIL', 'T=' + T, 'b=' + b, 'path=' + samePath, 'score=' + sameScore, JSON.stringify(got.slice(0, 4)), 'vs', JSON.stringify(r.path.slice(0, 4))); }
  }
}
console.log(`VITERBI-DIFF: pass=${pass} robustT1=${crashExpected} fail=${fail}`);
process.exit(fail ? 1 : 0);
