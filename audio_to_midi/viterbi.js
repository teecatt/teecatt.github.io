/* Transkun Semi-CRF Viterbi（viterbiBackward）JS 移植。
 * 逐行对应 transkun/CRF/NeuralSemiCRFInterval.py::viterbiBackward
 * （推理时 transcribe.py 用 decode(forcedStartPos, forward=False) 即此函数）。
 * 纯函数、无依赖：Worker 经 importScripts 加载，node 下可直接 eval 测试。
 * 参考实现与测试向量：export/viterbi_ref.py（纯 Python，无第三方依赖）。
 *
 * 接口（步进访问，避免 T=690 时复制 T×T×90 大矩阵）：
 *   decode({ T, getScore(end,begin), getSkip(t), forcedStart })
 *   → [[begin,end],...]（单 symbol；B=1）
 *   pathScore({T, intervals, getScore, getSkip}) → 路径分数（对应 evalPathSlow）
 * Worker 侧对 90 个 symbol 各调一次 decode（与 torch 的 nBatch=nSym 等价）。
 */
(function(root){
  'use strict';

  // 后向 Viterbi：score[end][begin]，skip[t]，forcedStart 为解码起点（默认 0）。
  function decode(args){
    const T = args.T, getScore = args.getScore, getSkip = args.getSkip;
    const forcedStart = args.forcedStart || 0;
    if(T <= 0) return [];
    if(T === 1){ // torch 原版 T=1 会 stack 空 ptr 报错；这里做鲁棒处理
      return (getScore(0, 0) > 0) ? [[0, 0]] : [];
    }
    const q = new Float64Array(T);
    const sLast = getScore(T - 1, T - 1);
    q[T - 1] = sLast > 0 ? sLast : 0;
    // ptr[j]：位置 j 的选择（-1=skip，否则为区间长度-1，即 end=j+sel+1）
    const ptr = new Int32Array(T);
    for(let i = 1; i < T; i++){
      const pe = T - i - 1;
      let bestV = q[T - i] + getSkip(T - i - 1);
      let bestSel = -1;
      for(let k = 0, j2 = T - i; j2 < T; j2++, k++){
        const cand = q[j2] + getScore(j2, pe);
        if(cand > bestV){ bestV = cand; bestSel = k; }
      }
      ptr[pe] = bestSel;
      const sDiag = getScore(pe, pe);
      q[pe] = bestV + (sDiag > 0 ? sDiag : 0);
    }
    // 回溯
    const res = [];
    let j = forcedStart;
    while(j < T - 1){
      if(getScore(j, j) > 0) res.push([j, j]); // 对角单点（可与区间共存，与原版一致）
      const sel = ptr[j];
      if(sel < 0){ j += 1; }
      else { const e2 = sel + j + 1; res.push([j, e2]); j = e2; }
    }
    if(getScore(T - 1, T - 1) > 0) res.push([T - 1, T - 1]);
    return res;
  }

  // 路径分数（对应 evalPathSlow），用于自检最优性。
  function pathScore(args){
    const T = args.T, list = args.intervals, getScore = args.getScore, getSkip = args.getSkip;
    const cum = new Float64Array(T + 1);
    for(let t = 0; t < T; t++) cum[t + 1] = cum[t] + (t < T - 1 ? getSkip(t) : 0);
    let v = cum[T - 1];
    for(let k = 0; k < list.length; k++){
      const bi = list[k][0], ei = list[k][1];
      v += getScore(ei, bi) - cum[ei] + cum[bi];
    }
    return v;
  }

  root.TranskunViterbi = { decode, pathScore };
})(typeof self !== 'undefined' ? self : globalThis);
