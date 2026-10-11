// JS/Python Viterbi 交叉验证：node test_viterbi.mjs [vectors.json]
// 向量由 export/viterbi_ref.py --gen 生成。 exit 0=全过。
import fs from 'fs';
import vm from 'vm';

const vecPath = process.argv[2] || '/tmp/opencode/viterbi_vectors.json';
const vec = JSON.parse(fs.readFileSync(vecPath, 'utf8'));
const src = fs.readFileSync(new URL('../viterbi.js', import.meta.url), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src + '\nthis.__V = TranskunViterbi;', sandbox);
const V = sandbox.__V;

let fails = 0;
vec.cases.forEach((c, ci) => {
  for (let b = 0; b < c.B; b++) {
    const getScore = (e, bi) => c.score[e][bi][b];
    const getSkip = (t) => (c.noise[t] ? c.noise[t][b] : 0);
    const forced = c.forced ? c.forced[b] : 0;
    const got = V.decode({ T: c.T, getScore, getSkip, forcedStart: forced });
    const exp = c.expected[b];
    const eq = got.length === exp.length &&
      got.every((p, k) => p[0] === exp[k][0] && p[1] === exp[k][1]);
    if (!eq) {
      fails++;
      console.log(`CASE ${ci} b=${b}: MISMATCH got=${got.length} exp=${exp.length}`);
      console.log('  got:', JSON.stringify(got.slice(0, 8)));
      console.log('  exp:', JSON.stringify(exp.slice(0, 8)));
    }
    // 最优性复核：解码路径 ≥ 空路径
    const sGot = V.pathScore({ T: c.T, intervals: got, getScore, getSkip });
    const sEmpty = V.pathScore({ T: c.T, intervals: [], getScore, getSkip });
    if (!(sGot + 1e-9 >= sEmpty)) { fails++; console.log(`CASE ${ci} b=${b}: PATH NOT OPTIMAL`); }
  }
});
console.log(fails === 0 ? `XTEST ALL PASS (${vec.cases.length} cases)` : `XTEST FAIL: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
