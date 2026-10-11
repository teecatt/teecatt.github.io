#!/usr/bin/env python3
"""Transkun Semi-CRF Viterbi（viterbiBackward）的纯Python参考实现。
逐行对应 transkun/CRF/NeuralSemiCRFInterval.py::viterbiBackward，
用于生成测试向量、与 audio_to_midi/viterbi.js 做交叉验证。
无第三方依赖。
"""
import json
import random
import sys


def viterbi_backward(score, noise, forced_starts=None):
    """score: [T][T]（score[end][begin]）；noise: [T-1]；返回 [(begin,end)] 列表。"""
    T = len(score)
    B = len(score[0][0])  # 与 torch 的 nBatch = score.shape[2] 对应
    if forced_starts is None:
        forced_starts = [0] * B
    assert len(forced_starts) == B
    assert all(len(row) == T for row in score)
    assert len(noise) == T - 1 or T == 1

    if T == 1:
        out = []
        for b in range(B):
            if score[0][0][b] > 0:
                out.append([(0, 0)])
            else:
                out.append([])
        return out

    q = [[0.0] * B for _ in range(T)]
    for b in range(B):
        q[T - 1][b] = score[T - 1][T - 1][b] * (1.0 if score[T - 1][T - 1][b] > 0 else 0.0)

    ptr = []  # ptr[(T-j-2)*B+b] 对应位置 j（逐 b 交错存放）
    new_q_col = [0.0] * B
    for i in range(1, T):
        pe = T - i - 1
        for b in range(B):
            best_v = q[T - i][b] + noise[T - i - 1][b]
            best_sel = -1
            k = 0
            for j2 in range(T - i, T):
                cand = q[j2][b] + score[j2][pe][b]
                if cand > best_v:
                    best_v = cand
                    best_sel = k
                k += 1
            ptr.append(best_sel)
            new_q_col[b] = best_v + (score[pe][pe][b] if score[pe][pe][b] > 0 else 0.0)
        for b in range(B):
            q[pe][b] = new_q_col[b]

    diag_inc = [[score[d][d][b] > 0 for d in range(T)] for b in range(B)]
    result = []
    for b in range(B):
        j = forced_starts[b]
        cur = []
        while j < T - 1:
            sel = ptr[(T - j - 2) * B + b]
            if diag_inc[b][j]:
                cur.append((j, j))
            if sel < 0:
                j += 1
            else:
                i2 = sel + j + 1
                cur.append((j, i2))
                j = i2
        if score[T - 1][T - 1][b] > 0:
            cur.append((T - 1, T - 1))
        result.append(cur)
    return result


def eval_path(intervals, score, noise):
    """对应 evalPathSlow：v = cumNoise[-1] + Σ(score[end,begin] - cum[end] + cum[begin])。"""
    T = len(score)
    B = len(noise[0]) if noise else 1
    out = []
    for b in range(B):
        cum = [0.0] * (T + 1)
        for t in range(T):
            cum[t + 1] = cum[t] + (noise[t][b] if t < len(noise) else 0.0)
        v = cum[T - 1] if T >= 1 else 0.0
        for (bi, ei) in intervals[b]:
            v += score[ei][bi][b] - cum[ei] + cum[bi]
        out.append(v)
    return out


def gen_vectors(path, seed=7):
    rng = random.Random(seed)
    cases = []
    for (T, B, forced) in [(1, 1, None), (5, 2, None), (40, 3, None),
                           (40, 3, [5, 0, 20]), (120, 2, [0, 60])]:
        score = [[[rng.gauss(0, 1) for _ in range(B)] for _ in range(T)] for _ in range(T)]
        noise = [[rng.gauss(0, 1) for _ in range(B)] for _ in range(T - 1)] if T > 1 else []
        # 植入一个强区间，保证至少有一条可验证的非空路径
        if T > 10:
            bi, ei = T // 4, T // 2
            for b in range(B):
                score[ei][bi][b] = 25.0
                score[bi][bi][b] = 5.0
                score[ei][ei][b] = 5.0
        exp = viterbi_backward(score, noise, forced)
        cases.append({"T": T, "B": B, "forced": forced, "score": score,
                      "noise": noise, "expected": [list(map(list, r)) for r in exp]})
    with open(path, "w") as f:
        json.dump({"cases": cases}, f)
    print("wrote %s (%d cases)" % (path, len(cases)))


def selftest():
    rng = random.Random(123)
    for trial in range(30):
        T = rng.choice([2, 3, 8, 25, 60])
        B = rng.choice([1, 2, 4])
        score = [[[rng.gauss(0, 2) for _ in range(B)] for _ in range(T)] for _ in range(T)]
        noise = [[rng.gauss(0, 2) for _ in range(B)] for _ in range(T - 1)]
        forced = [rng.randrange(0, T) for _ in range(B)]
        res = viterbi_backward(score, noise, forced)
        # 1) 起点约束：所有区间起点 ≥ forced
        for b in range(B):
            for (bi, ei) in res[b]:
                assert bi >= forced[b], (trial, b, bi, forced[b])
                assert 0 <= bi <= ei < T, (trial, b, bi, ei, T)
        # 2) 最优性：解码路径分数 ≥ 空路径分数
        got = eval_path(res, score, noise)
        empty = eval_path([[] for _ in range(B)], score, noise)
        for b in range(B):
            assert got[b] + 1e-6 >= empty[b], (trial, b, got[b], empty[b])
    print("selftest: 30 trials OK (起点约束+最优性)")


if __name__ == "__main__":
    if "--gen" in sys.argv:
        gen_vectors(sys.argv[sys.argv.index("--gen") + 1])
    else:
        selftest()
