# agent_run：Node 直跑真实管线（无页面调试入口）

环境：`pip install miniaudio`；本目录 `npm i onnxruntime-node`（缺失即报错，不自动装）。

解码（mp3→Float32LE裸pcm，单声道44.1k）：`python3 -c "import miniaudio,struct; d=miniaudio.decode_file('test/AfterSchool.mp3',output_format=miniaudio.SampleFormat.FLOAT32,nchannels=1,sample_rate=44100); open('/tmp/seg.pcm','wb').write(struct.pack('<%df'%len(d.samples),*d.samples))"`

权重：`curl -L -o models/transkun_scorer.onnx https://weights.down2.top/transkun_scorer.onnx`；`curl -L -o models/transkun_attr.onnx https://weights.down2.top/transkun_attr.onnx`（备用直链见 app.js MODEL_R2_DIRECT）。

全量：`node agent_run.mjs --pcm /tmp/seg.pcm --sr 44100 --out /tmp/out.mid`（冒烟加 `--segments 1` 只跑首段）。

输出：MIDI 写 `--out`；stdout 一行 JSON：`{msTotal,msMelPerSeg,msScorePerCall,backend,notes,midi}`。

解读：`notes`=音符数；`msMelPerSeg`≈每段mel耗时；`msScorePerCall`≈每段打分耗时；冒烟应 notes>0 且退出码0。

原理：vm 沙箱整份跑 `../worker.js`+`viterbi.js`原文（锚点校验，抽取函数见 agent_run.mjs 头注释），CPU 会话跑真实 inferAll；不改 worker/app 逻辑。
