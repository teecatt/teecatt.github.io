#!/usr/bin/env python3
"""fp16 链验证 dump：torch mel（dump_seg 已落盘）→ fp16 scorer → fp32 attr → 落盘，供 node 真管线验证。
用法：/usr/bin/python3 audio_to_midi/export/dump_fp16.py [srcdir] [outdir]"""
import sys, os, json
import numpy as np
import onnxruntime as ort

SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/opencode/e2e'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/opencode/e2e16'
os.makedirs(OUT, exist_ok=True)
src = open('/sdcard/1011/audio_to_midi/export/dump_seg.py').read()
ns = {'np': np}
exec(src[src.index('def viterbi_np'):src.index('SEG_SEC, STEP_SEC')], ns)
viterbi_np = ns['viterbi_np']

so = ort.SessionOptions(); so.intra_op_num_threads = 1; so.inter_op_num_threads = 1
s16 = ort.InferenceSession('/tmp/opencode/onnx_out/transkun_scorer_fp16.onnx', so, providers=['CPUExecutionProvider'])
a32 = ort.InferenceSession('/tmp/opencode/onnx_out/transkun_attr.onnx', so, providers=['CPUExecutionProvider'])
meta = json.load(open(f'{SRC}/meta.json'))
import shutil
shutil.copy(f'{SRC}/pcm_f32.bin', f'{OUT}/pcm_f32.bin')
for s in range(meta['nSeg']):
    d = f'{SRC}/seg{s}'
    mel = np.load(d + '_mel.npy')
    S, Ss, C = s16.run(None, {'mel': mel})
    info = json.load(open(d + '.json'))
    paths = [viterbi_np(S.astype(np.float64)[:, :, x], Ss[:, x].astype(np.float64), 691, forced=info['startPos'][x]) for x in range(90)]
    nIv = sum(map(len, paths))
    if nIv:
        ca = np.stack([C[0, x, b] for x in range(90) for (b, e) in paths[x]]).astype(np.float32)
        cb = np.stack([C[0, x, e] for x in range(90) for (b, e) in paths[x]]).astype(np.float32)
        ov, oV, oP = a32.run(None, {'ctx_a': ca, 'ctx_b': cb})
    else:
        ca = np.zeros((0, 256), np.float32); cb = np.zeros((0, 256), np.float32)
        ov, oV, oP = np.zeros((0,), np.int64), np.zeros((0, 2), np.float32), np.zeros((0, 2), bool)
    for name, arr in (('S', S), ('Sskip', Ss), ('CTX', C), ('mel', mel), ('ca', ca), ('cb', cb),
                      ('vel', np.asarray(ov)), ('ofVal', np.asarray(oV)), ('ofPres', np.asarray(oP))):
        np.save(f'{OUT}/seg{s}_{name}.npy', arr)
    json.dump({'paths': [[[int(b), int(e)] for (b, e) in p] for p in paths],
               'startPos': [int(v) for v in info['startPos']], 'nIv': int(nIv)},
              open(f'{OUT}/seg{s}.json', 'w'))
    print(f'seg{s}: nIv={nIv}', flush=True)
shutil.copy(f'{SRC}/meta.json', f'{OUT}/meta.json')
print(f'DUMP-FP16-OK -> {OUT}', flush=True)
