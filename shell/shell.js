/* MWS — Multi-Window Shell（多窗口同步壳）v2.0 —— 像素画布模式
   通用于任意网站的一层外壳：不识别页面任何内容，而是把整页当成一张
   不透明位图放在虚拟画布上，各窗口按像素裁剪显示。

   接入（必须放在 <head> 内、<title> 之后）：
     <script src="/shell/shell.js"></script>
     页面可选提供 window.ShellAdapter（仅业务状态中继，与布局无关，契约见 README）。

   双模式（脚本自动分流，页面无感知）：
   - host（顶层窗口）：document.open 接管文档 → 本窗口只放一个
     尺寸=整块画布的 <iframe>（src=原页面&mws=inner），自身仅保留
     覆盖层：扫描线/大字钟/水印/控制面板。几何协议：
       画布 Wv=Σ窗宽, Hv=最高窗高, s=1:1, OX=宽度前缀, OY=0（顶对齐）
   - inner（iframe 内）：页面正常渲染，完全不知道自己被裁剪；
     只做窗口互认（静音选主）与业务状态中继。

   扫描线（画布坐标，host 层绘制）：
   - 横竖两线同相位，交点沿画布对角线匀速移动：
     去程 f:0→1（左上角→右下角），回程 f:1→0（原路返回左上角）；
   - 屏障：收齐所有可见 host 的 swdone（往返走完）才生成下一轮；几何变化立即重开；
   - 协调者 startCycle 250ms 节流，防止视图收敛期 cycle 对轰。
*/
(function () {
  'use strict';
  if (window.__MWS) return;
  const MWS = window.__MWS = { version: '2.0' };

  /* ================= 模式分流 ================= */
  const q = new URLSearchParams(location.search);
  const IS_TOP = (function () { try { return window.self === window.top; } catch (e) { return false; } })();
  const MODE = IS_TOP ? 'host' : (q.get('mws') === 'inner' ? 'inner' : 'passive');
  MWS.mode = MODE;

  /* host：在 <head> 阶段接管文档——中止原页面解析，写入纯净宿主骨架
     （原页面的 body 脚本、DOM 全部不执行，由 iframe 内实例承担） */
  if (MODE === 'host') {
    const keepTitle = document.title;
    try {
      document.open();
      document.write('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1"><title></title></head>' +
        '<body style="margin:0;overflow:hidden;background:#0b0e14"></body></html>');
      document.close();
      if (keepTitle) document.title = keepTitle;
    } catch (e) { console.warn('[MWS] 宿主接管失败，回退普通模式', e); }
  }

  /* ================= 身份 / 配置 ================= */
  const CH = MODE === 'host' ? 'mws.v1' : 'mws.page';   // host 几何层 / 内容中继层 分道
  const MY_ID = (crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now();
  const BORN = Date.now();
  const LEAD = 300, ACK_TIMEOUT = 4000;
  const LS = { lines: 'mws_lines', pos: 'mws_panel_pos' };
  let linesOn = (() => { const v = localStorage.getItem(LS.lines); return v === null ? true : v !== '0'; })();

  const SH = { sv: 0, ord: {}, sw: null };   // 仅 host 使用（序号/扫描轮）
  let psv = 0, applying = false;             // 仅 inner/passive（业务状态中继）
  let dispOffset = 0;                        // host 持有，postMessage 转交自己的 iframe

  let adapter = window.ShellAdapter || null;
  const assignCbs = [];
  let myIndex = 0, myCount = 1;

  /* ================= 通信 ================= */
  let bc = null;
  try { bc = new BroadcastChannel(CH); } catch (e) {}
  function send(m) {
    m._from = MY_ID;
    if (bc) { try { bc.postMessage(m); } catch (e) {} }
    try { localStorage.setItem(CH, JSON.stringify({ ...m, _n: Math.random() })); } catch (e) {}
  }
  const handlers = [];
  function onMsg(fn) { handlers.push(fn); }
  function dispatch(m) {
    if (!m || m._from === MY_ID) return;
    for (const fn of handlers) { try { fn(m); } catch (e) { console.warn('[MWS]', e); } }
  }
  if (bc) bc.onmessage = e => dispatch(e.data);
  window.addEventListener('storage', e => {
    if (e.key !== CH || !e.newValue) return;
    try { dispatch(JSON.parse(e.newValue)); } catch (err) {}
  });

  /* ================= 在场与编号（host 与 inner 各自成组） ================= */
  const peers = new Map();
  function myWH() { return { w: Math.max(1, window.innerWidth || 1280), h: Math.max(1, window.innerHeight || 720) }; }
  function hello(hidden) {
    const wh = myWH();
    send({ type: 'hello', id: MY_ID, born: BORN, hidden: hidden === undefined ? document.hidden : hidden, w: wh.w, h: wh.h });
  }
  function peerWH(id) {
    if (id === MY_ID) return myWH();
    const p = peers.get(id);
    return { w: (p && p.w) || 1280, h: (p && p.h) || 720 };
  }
  function liveIds() {
    const ids = [...peers.keys()];
    ids.push(MY_ID);
    ids.sort((a, b) => {
      const pa = a === MY_ID ? { born: BORN } : peers.get(a);
      const pb = b === MY_ID ? { born: BORN } : peers.get(b);
      if (pa && pb && pa.born !== pb.born) return pa.born - pb.born;
      return a < b ? -1 : 1;
    });
    return ids;
  }
  function prune() {
    const now = Date.now(); let ch = false;
    for (const [id, p] of peers) if (now - p.lastSeen > 2600) { peers.delete(id); ch = true; }
    return ch;
  }
  function computeAssign() {
    prune();
    const ids = liveIds(), n = ids.length;
    const slots = new Array(n).fill(null), assigned = new Map();
    if (MODE === 'host') {                        // 序号覆写仅 host 层（用户在面板操作）
      for (const id of ids) {
        const f = Number(SH.ord[id]);
        if (!f) continue;
        const k = Math.min(n, Math.max(1, f)) - 1;
        if (slots[k] == null) { slots[k] = id; assigned.set(id, k); }
      }
    }
    let fill = 0;
    for (const id of ids) {
      if (assigned.has(id)) continue;
      while (fill < n && slots[fill] != null) fill++;
      if (fill >= n) break;
      slots[fill] = id; assigned.set(id, fill); fill++;
    }
    return { ids, idx: assigned.has(MY_ID) ? assigned.get(MY_ID) : ids.indexOf(MY_ID), n };
  }
  function reassign() {
    const a = computeAssign();
    const changed = a.idx !== myIndex || a.n !== myCount;
    myIndex = a.idx; myCount = a.n;
    if (changed) {
      /* 像素模式：不再有语义分片——slice 恒为 null，页面整幅布局在画布上 */
      const payload = { index: myIndex, count: myCount, slice: null };
      if (adapter && adapter.onAssign) { try { adapter.onAssign(payload); } catch (e) { console.warn(e); } }
      for (const cb of assignCbs) { try { cb(payload); } catch (e) {} }
      if (MODE === 'host') { renderPanel(); renderSteps(); updateFrame(); }
    }
    return changed;
  }

  /* ================= host 几何：画布与本窗裁剪矩形 ================= */
  function hostGeom() {
    const ids = liveIds();
    const segs = []; let total = 0, maxw = 0, Hv = 0;
    for (const id of ids) {
      const { w, h } = peerWH(id);
      segs.push({ id, ox: total, oy: 0, w, h });
      total += w; if (w > maxw) maxw = w; if (h > Hv) Hv = h;
    }
    const T = Math.max(1500, Math.round(1000 * total / Math.max(1, maxw)));   // 横扫周期；纵扫同周期走完 Hv
    const sig = ids.map((id, i) => id.slice(0, 8) + ':' + Math.round(segs[i].w / 20) + 'x' + Math.round(segs[i].h / 20)).join('|');
    return { ids, segs, total, maxw, Hv, T, sig };
  }
  function myRect(g) {
    const seg = g.segs.find(s => s.id === MY_ID);
    return seg || { ox: 0, oy: 0, w: myWH().w, h: myWH().h };
  }

  /* ================= 扫描线：屏障 / 求值（仅 host） ================= */
  const swAcks = new Map();
  let ackedCycle = -1, sawH = false, sawV = false, rttEma = 0;
  function onNewCycle() { ackedCycle = -1; sawH = false; sawV = false; }
  function evalSweep(now) {
    const sw = SH.sw;
    if (MODE !== 'host' || !linesOn || !sw) return null;
    const t = now - sw.startAt;
    const T2 = sw.T * 2;                       // 一个周期 = 去程(T) + 回程(T)
    if (t < 0 || t >= T2) return null;
    const g = hostGeom();
    const me = myRect(g);
    /* 画布坐标匀速往返：去程 f:0→1（左上→右下），回程 f:1→0（右下→左上） */
    const f = t < sw.T ? (t / sw.T) : (1 - (t - sw.T) / sw.T);
    const gx = f * (sw.total || g.total);
    const gy = f * (sw.Hv || g.Hv);
    const lx = gx - me.ox, ly = gy - me.oy;
    const xVis = lx >= 0 && lx < me.w;         // 竖线穿过本窗
    const yVis = ly >= 0 && ly < me.h;         // 横线穿过本窗
    if (xVis) sawV = true;
    if (yVis) sawH = true;
    return { lx, ly, xVis, yVis, f };
  }
  function localAck(cycle) {
    if (ackedCycle === cycle) return;
    ackedCycle = cycle; sawH = false; sawV = false;
    let s = swAcks.get(cycle); if (!s) { s = new Set(); swAcks.set(cycle, s); }
    s.add(MY_ID);
    send({ type: 'swdone', cycle });
  }
  function maybeAck(force) {
    const sw = SH.sw;
    if (MODE !== 'host' || !linesOn || !sw || ackedCycle === sw.cycle) return;
    const t = Date.now() - sw.startAt;
    if (t < sw.T * 2) return;                            // 去程+回程都走完才可能确认
    if ((sawH && sawV) || force || t > sw.T * 2 + 2500) localAck(sw.cycle);
  }
  let lastCycleAt = 0;
  function startCycle(cycle, g, now) {
    if (now - lastCycleAt < 250) return;                 // 节流：视图收敛期间不许 cycle 对轰飞转
    lastCycleAt = now;
    SH.sw = { cycle, startAt: now + LEAD, T: g.T, Hv: g.Hv, total: g.total, sig: g.sig, segs: g.segs };
    pushShell();
    onNewCycle();
    for (const k of [...swAcks.keys()]) if (k < cycle) swAcks.delete(k);
  }
  function coordinator() {
    if (MODE !== 'host' || !linesOn || myIndex !== 0) return;
    const now = Date.now();
    const g = hostGeom();
    const sw = SH.sw;
    if (!sw || sw.sig !== g.sig) { startCycle(sw ? sw.cycle + 1 : 0, g, now); return; }
    if (now < sw.startAt + sw.T * 2) return;             // 往返未结束
    const acks = swAcks.get(sw.cycle) || new Set();
    const required = liveIds().filter(id => { const p = peers.get(id); return !(p && p.hidden); });
    const allDone = required.every(id => acks.has(id));
    if (allDone || now > sw.startAt + sw.T * 2 + ACK_TIMEOUT) startCycle(sw.cycle + 1, g, now);
  }

  /* ================= 业务状态中继（仅 inner/passive） ================= */
  function notifyPage() {
    if (MODE === 'host' || !adapter || applying || !adapter.getState) return;
    let data; try { data = adapter.getState(); } catch (e) { return; }
    psv = Date.now();
    send({ type: 'page', psv, data });
  }
  MWS.notify = notifyPage;
  MWS.onAssign = cb => { assignCbs.push(cb); cb({ index: myIndex, count: myCount, slice: null }); };
  MWS.assignment = () => ({ index: myIndex, count: myCount, slice: null });
  MWS.setOffset = ms => {                     // host 面板 → 自己的 iframe（每显示器独立）
    dispOffset = ms;
    try { if (frameEl && frameEl.contentWindow) frameEl.contentWindow.postMessage({ mws: 'offset', ms }, location.origin); } catch (e) {}
  };

  /* ================= 消息处理 ================= */
  onMsg(m => {
    if (m.type === 'hello') {
      const isNew = !peers.has(m.id);
      peers.set(m.id, { born: m.born, hidden: !!m.hidden, w: m.w | 0 || 1280, h: m.h | 0 || 720, lastSeen: Date.now() });
      if (isNew) hello();          // 立即回应新窗口：修开机广播早于对方存在的丢包（免等下个800ms周期）
      reassign();
      if (MODE === 'host') updateFrame();
    } else if (m.type === 'state' && MODE === 'host') {
      if (m.sv <= SH.sv) return;
      const oldCycle = SH.sw ? SH.sw.cycle : -1;
      SH.sv = m.sv; SH.ord = (m.ord && typeof m.ord === 'object') ? m.ord : {};
      SH.sw = m.sw || null;
      if (!SH.sw || SH.sw.cycle !== oldCycle) onNewCycle();
      reassign(); renderPanel();
    } else if (m.type === 'page' && MODE !== 'host') {
      if (m.psv <= psv) return;
      psv = m.psv;
      if (adapter && adapter.applyState) {
        applying = true;
        try { adapter.applyState(m.data); } catch (e) { console.warn('[MWS] applyState', e); }
        finally { applying = false; }
      }
    } else if (m.type === 'swdone' && MODE === 'host') {
      let s = swAcks.get(m.cycle); if (!s) { s = new Set(); swAcks.set(m.cycle, s); }
      s.add(m._from);
    } else if (m.type === 'ping') {
      send({ type: 'pong', to: m.id, t: m.t });
    } else if (m.type === 'pong' && m.to === MY_ID) {
      rttEma = rttEma ? rttEma * 0.7 + (Date.now() - m.t) * 0.3 : (Date.now() - m.t);
      if (panelEls.rtt) panelEls.rtt.textContent = rttEma.toFixed(1) + 'ms';
    }
  });
  function pushShell() { SH.sv = Date.now(); send({ type: 'state', sv: SH.sv, ord: SH.ord, sw: SH.sw }); }

  /* ================= host DOM（Shadow DOM：iframe + 覆盖层 + 面板） ================= */
  const panelEls = {};
  let shadow = null, cv = null, ctx = null, clockEl = null, frameEl = null, stepsEl = null;
  let W = 0, H = 0, DPR = 1;
  let bannerDismissed = (() => { try { return sessionStorage.getItem('mws_banner_x') === '1'; } catch (e) { return false; } })();
  function el(sh, tag, css, html) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (html !== undefined) e.innerHTML = html;
    sh.appendChild(e);
    return e;
  }
  function buildDom() {
    const host = document.createElement('mws-root');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none';
    shadow = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = `
      *{box-sizing:border-box;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif}
      iframe#f{position:fixed;border:0;will-change:transform;transform-origin:0 0;background:#0b0e14;pointer-events:auto}
      #cv{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
      #clock{position:fixed;right:12px;top:10px;font-size:clamp(15px,2vw,24px);font-weight:700;
        letter-spacing:1px;color:rgba(230,237,243,.85);text-shadow:0 2px 8px #000;
        font-variant-numeric:tabular-nums;pointer-events:none}
      #panel{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);display:flex;gap:7px;
        align-items:center;flex-wrap:wrap;justify-content:center;max-width:96vw;padding:7px 11px;
        background:rgba(11,14,20,.9);border:1px solid #232a3a;border-radius:12px;
        backdrop-filter:blur(6px);pointer-events:auto;box-shadow:0 6px 24px rgba(0,0,0,.45);
        cursor:grab;transition:opacity .25s,transform .25s;user-select:none}
      #panel:active{cursor:grabbing}
      #panel.idle{opacity:0;pointer-events:none;transform:translateX(-50%) translateY(10px)}
      .b{background:#1a2130;color:#cdd6f4;border:1px solid #2c3550;border-radius:6px;
        padding:4px 9px;font-size:13px;cursor:pointer}
      .b:hover{background:#253048}
      .badge{background:#1d3f2e;color:#6be49a;font-weight:700;font-size:12px;padding:4px 10px;
        border-radius:99px;white-space:nowrap}
      .s{font-size:12px;color:#9aa4bf;white-space:nowrap}
      input[type=range]{accent-color:#3b7ddd;width:100px;vertical-align:middle}
      select{background:#1a2130;color:#cdd6f4;border:1px solid #2c3550;border-radius:6px;
        padding:3px 6px;font-size:13px}
      #banner{position:fixed;left:50%;top:10px;transform:translateX(-50%);display:none;gap:9px;
        align-items:center;background:#3f2f1d;border:1px solid #6b5526;color:#f0c674;
        border-radius:8px;padding:7px 13px;font-size:13px;max-width:92vw;pointer-events:auto}
      #steps{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
        background:rgba(5,7,11,.92);padding:20px;pointer-events:auto}
      #steps .card{max-width:700px;width:100%;background:#12161f;border:1px solid #262d40;
        border-radius:14px;padding:24px 28px;color:#cdd6f4}
      #steps h2{font-size:18px;margin-bottom:4px;color:#e6edf3}
      #steps .sub{font-size:13px;color:#9aa4bf;margin-bottom:14px}
      #steps ol{list-style:none;margin:0 0 16px}
      #steps li{padding:9px 12px;margin-bottom:8px;background:#171c28;border:1px solid #232a3a;
        border-radius:9px;font-size:13.5px;line-height:1.55}
      #steps li.ok{border-color:#2c5a3f}
      #steps .acts{display:flex;gap:9px;flex-wrap:wrap}
      #hint{position:fixed;right:10px;bottom:64px;font-size:11px;color:rgba(154,164,191,.75);
        text-align:right;max-width:46vw;pointer-events:none}
      @media(max-width:700px){#hint{display:none}}
    `;
    shadow.appendChild(st);

    /* iframe = 整块画布上的本窗裁剪视口 */
    const u = new URL(location.href);
    u.searchParams.set('mws', 'inner');
    frameEl = document.createElement('iframe');
    frameEl.id = 'f';
    frameEl.src = u.pathname + u.search + u.hash;
    frameEl.setAttribute('allow', 'autoplay; fullscreen; clipboard-write; clipboard-read');
    shadow.appendChild(frameEl);

    cv = el(shadow, 'canvas'); cv.id = 'cv';
    clockEl = el(shadow, 'div', '', '000000'); clockEl.id = 'clock';

    const banner = el(shadow, 'div', '', '<span id="bTxt"></span><button class="b" id="bOpen">拆成独立窗口</button><button class="b" id="bX">✕</button>');
    banner.id = 'banner';
    panelEls.bTxt = banner.querySelector('#bTxt');
    banner.querySelector('#bX').onclick = () => { bannerDismissed = true; try { sessionStorage.setItem('mws_banner_x', '1'); } catch (e) {} updateBanner(); };
    banner.querySelector('#bOpen').onclick = openWin;

    const p = el(shadow, 'div'); p.id = 'panel';
    p.innerHTML =
      '<span class="badge" id="pBadge">#1/1</span>' +
      '<span class="s" id="pGeom"></span>' +
      '<span class="s">序号<select id="pSeq"></select></span>' +
      '<button class="b" id="pLines" title="扫描线开关">✛ 线</button>' +
      '<span class="s">显示偏移<b id="pOff">+0ms</b><input type="range" id="pOffR" min="-300" max="300" step="4" value="0"></span>' +
      '<span class="s">RTT <b id="pRtt">–</b></span>' +
      '<button class="b" id="pOpen">＋ 开窗</button>' +
      '<button class="b" id="pFull">⛶</button>' +
      '<button class="b" id="pHelp">?</button>';
    for (const [k, id] of [['badge', 'pBadge'], ['geom', 'pGeom'], ['seq', 'pSeq'], ['lines', 'pLines'],
      ['off', 'pOff'], ['offR', 'pOffR'], ['rtt', 'pRtt'], ['open', 'pOpen'], ['full', 'pFull'], ['help', 'pHelp']]) {
      panelEls[k] = p.querySelector('#' + id);
    }
    panelEls.lines.textContent = linesOn ? '✛ 线' : '▢ 线';
    panelEls.open.onclick = openWin;
    panelEls.full.onclick = () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); };
    panelEls.help.onclick = () => { stepsEl.style.display = 'flex'; renderSteps(); };
    panelEls.lines.onclick = () => {
      linesOn = !linesOn; localStorage.setItem(LS.lines, linesOn ? '1' : '0');
      panelEls.lines.textContent = linesOn ? '✛ 线' : '▢ 线';
      if (linesOn) onNewCycle();
    };
    panelEls.offR.oninput = e => MWS.setOffset(Number(e.target.value));
    panelEls.seq.onchange = e => {
      const v = Number(e.target.value);
      if (!v) delete SH.ord[MY_ID];
      else {
        const other = liveIds().find(id => id !== MY_ID && Number(SH.ord[id]) === v);
        if (other) SH.ord[other] = myIndex + 1;
        SH.ord[MY_ID] = v;
      }
      pushShell(); reassign(); renderPanel();
    };
    /* 面板：可拖拽（位置持久化） */
    const saved = (() => { try { return JSON.parse(localStorage.getItem(LS.pos) || 'null'); } catch (e) { return null; } })();
    if (saved) { p.style.left = saved.x + 'px'; p.style.top = saved.y + 'px'; p.style.bottom = 'auto'; p.style.transform = 'none'; }
    p.addEventListener('pointerdown', e => {
      if (e.target.closest('button,select,input')) return;
      const r0 = p.getBoundingClientRect(), ox = e.clientX - r0.left, oy = e.clientY - r0.top;
      const mv = ev => {
        const x = Math.max(4, Math.min(window.innerWidth - 120, ev.clientX - ox));
        const y = Math.max(4, Math.min(window.innerHeight - 44, ev.clientY - oy));
        p.style.left = x + 'px'; p.style.top = y + 'px'; p.style.bottom = 'auto'; p.style.transform = 'none';
      };
      const up = () => {
        document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
        const r = p.getBoundingClientRect();
        try { localStorage.setItem(LS.pos, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); } catch (e2) {}
      };
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
      e.preventDefault();
    });
    /* 面板：空闲自动隐藏，移动鼠标唤出 */
    let idleT = 0;
    const poke = () => {
      p.classList.remove('idle'); clearTimeout(idleT);
      idleT = setTimeout(() => p.classList.add('idle'), 3000);
    };
    document.addEventListener('mousemove', poke); poke();

    const hint = el(shadow, 'div', '', '整页 = 一块画布，按像素裁剪到各窗（含顶部按键区）<br>横竖两线匀速 TL→BR→TL 往返 · 交点即画布坐标 · 大字钟差 = 显示延迟');
    hint.id = 'hint';

    stepsEl = el(shadow, 'div'); stepsEl.id = 'steps';
    stepsEl.innerHTML =
      '<div class="card"><h2>🖼️ 多窗口像素画布壳</h2>' +
      '<div class="sub">本页整幅渲染在一块虚拟画布上，每个窗口显示画布的一块像素区域——页面内容（按钮、琴键、工具栏）全部随之切开，壳不识别页面任何内容</div>' +
      '<ol><li id="s1"></li><li id="s2"></li><li id="s3"></li></ol>' +
      '<div class="acts"><button class="b" id="sDone">✓ 开始使用</button>' +
      '<button class="b" id="sOpen">＋ 再开一个窗口</button></div>' +
      '<div class="sub" style="margin-top:12px">多屏用<b>独立窗口</b>分屏；面板空闲自动隐藏（移鼠标唤出，可拖拽）；<b>首次在每个窗口点一下</b>解锁页面音频；后台标签会被冻结</div></div>';
    stepsEl.querySelector('#sDone').onclick = () => stepsEl.style.display = 'none';
    stepsEl.querySelector('#sOpen').onclick = openWin;
    stepsEl.addEventListener('click', e => { if (e.target === stepsEl) stepsEl.style.display = 'none'; });

    (document.body || document.documentElement).appendChild(host);
    ctx = cv.getContext('2d');
    renderPanel(); renderSteps(); resize();
  }

  function renderPanel() {
    if (!shadow) return;
    panelEls.badge.textContent = '#' + (myIndex + 1) + ' / ' + myCount + ' 窗';
    const g = hostGeom(), r = myRect(g);
    panelEls.geom.textContent = '画布 ' + g.total + '×' + g.Hv + ' · 本窗x' + r.ox + '+' + r.w;
    let html = '<option value="">自动</option>';
    for (let i = 1; i <= myCount; i++) html += '<option value="' + i + '">#' + i + '</option>';
    if (panelEls.seq.innerHTML !== html) panelEls.seq.innerHTML = html;
    const f = Number(SH.ord[MY_ID]);
    panelEls.seq.value = f ? String(Math.min(myCount, Math.max(1, f))) : '';
    const off = panelEls.off;
    if (off) off.textContent = (dispOffset >= 0 ? '+' : '') + dispOffset + 'ms';
    const rr = panelEls.offR;
    if (rr && Number(rr.value) !== dispOffset) rr.value = String(dispOffset);
  }
  function renderSteps() {
    if (!stepsEl || stepsEl.style.display === 'none') return;
    const s1 = stepsEl.querySelector('#s1'), s2 = stepsEl.querySelector('#s2'), s3 = stepsEl.querySelector('#s3');
    if (myCount >= 2) {
      s1.className = 'ok';
      s1.innerHTML = '① <b>互认：</b>✅ 已识别 <b>' + myCount + '</b> 个窗口 → 画布 ' +
        hostGeom().total + '×' + hostGeom().Hv + 'px（1:1）';
      s2.className = 'ok';
      s2.innerHTML = '② <b>分片：</b>本窗 <b>#' + (myIndex + 1) + '</b> = 画布 x' + myRect(hostGeom()).ox +
        ' 起 ' + myRect(hostGeom()).w + 'px（序号下拉可手动改号/对调，画布即时重排）';
    } else {
      s1.className = ''; s1.innerHTML = '① <b>互认：</b>再开一个本页窗口（或点「＋开窗」），整页即按像素拼接';
      s2.className = ''; s2.innerHTML = '② <b>分片：</b>单窗 = 整块画布';
    }
    s3.className = '';
    s3.innerHTML = '③ <b>标定：</b>手机拍两窗读<b>大字钟</b>毫秒差 = 显示延迟差 → 填「显示偏移」；' +
      '横竖两线<b>匀速</b>从画布左上角扫到右下角、再原路扫回左上角，交点 = 画布坐标；' +
      '所有窗口走完往返才生成下一轮';
    const g = hostGeom();
    const dpr = window.devicePixelRatio || 1;
    const mem = g.total * g.Hv * dpr * dpr * 4 * 4 / 1024 / 1024;   // 粗估：每窗一份画布级光栅
    if (g.total * g.Hv * dpr * dpr > 12e6) {
      s3.innerHTML += '<br><span style="color:#e8b64c">⚠ 画布光栅较大（约 ' + Math.round(mem) +
        'MB/窗量级），高 DPR 大墙建议降低系统显示缩放</span>';
    }
  }
  function updateBanner() {
    if (!shadow) return;
    const b = shadow.querySelector('#banner');
    let hidden = 0;
    for (const [, p] of peers) if (p.hidden) hidden++;
    if (!bannerDismissed && hidden > 0 && myCount > 1) {
      panelEls.bTxt.textContent = '有窗口在后台（渲染被冻结）。请用「拆成独立窗口」分屏：';
      b.style.display = 'flex';
    } else b.style.display = 'none';
  }
  function openWin() {
    const u = new URL(location.href);
    u.searchParams.delete('mws');
    window.open(u.pathname + u.search + u.hash, '_blank', 'width=1000,height=660,menubar=no,toolbar=no');
  }

  /* ================= iframe 裁剪与覆盖层绘制（host） ================= */
  function updateFrame() {
    if (!frameEl) return;
    const g = hostGeom(), r = myRect(g);
    frameEl.style.width = g.total + 'px';
    frameEl.style.height = g.Hv + 'px';
    frameEl.style.left = (-r.ox) + 'px';
    frameEl.style.top = (-r.oy) + 'px';
  }
  function resize() {
    if (!cv) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    if (ctx) ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    updateFrame();
  }
  function draw() {
    const now = Date.now();
    if (ctx) {
      ctx.clearRect(0, 0, W, H);
      const g = hostGeom(), r = myRect(g);
      /* 水印 */
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(230,237,243,.13)';
      ctx.font = '700 ' + Math.min(96, H * 0.13) + 'px system-ui';
      ctx.fillText('#' + (myIndex + 1), 14, 118);
      ctx.fillStyle = 'rgba(154,164,191,.55)';
      ctx.font = '13px system-ui';
      ctx.fillText('#' + (myIndex + 1) + '/' + myCount + ' · x' + r.ox + '+' + r.w, 16, 142);
      /* 扫描线（画布坐标） */
      if (MODE === 'host' && linesOn && SH.sw) {
        const s = evalSweep(now);
        if (s) {
          ctx.strokeStyle = 'rgba(255,255,255,.92)';
          ctx.lineWidth = 2;
          /* 两线交点 = 画布坐标 (f·Wv, f·Hv)：匀速 TL→BR→TL 往返 */
          if (s.xVis) { ctx.beginPath(); ctx.moveTo(s.lx, 0); ctx.lineTo(s.lx, H); ctx.stroke(); }
          if (s.yVis) { ctx.beginPath(); ctx.moveTo(0, s.ly); ctx.lineTo(W, s.ly); ctx.stroke(); }
        }
        maybeAck(false);
      }
    }
    if (clockEl) clockEl.textContent = String(now % 1000000).padStart(6, '0');
    requestAnimationFrame(draw);
  }

  /* ================= inner：偏移接收 + 就绪握手 ================= */
  function applyOffsetLocal(ms) {
    if (!adapter) return;
    if (adapter.applyOffset) { try { adapter.applyOffset(ms); } catch (e) {} }
  }
  if (MODE !== 'host') {
    window.addEventListener('message', e => {
      if (e.data && e.data.mws === 'offset') { dispOffset = Number(e.data.ms) || 0; applyOffsetLocal(dispOffset); }
    });
    /* 适配器就绪后向宿主索取当前偏移 */
    const handshake = setInterval(() => {
      if (!adapter) return;
      clearInterval(handshake);
      try { if (window.parent && window.parent !== window) window.parent.postMessage({ mws: 'ready' }, location.origin); } catch (e) {}
    }, 300);
  } else {
    /* 宿主：iframe 就绪 → 下发偏移 */
    window.addEventListener('message', e => {
      if (e.data && e.data.mws === 'ready') MWS.setOffset(dispOffset);
    });
  }

  /* ================= 定时器（按模式） ================= */
  setInterval(() => { hello(); }, 800);
  setInterval(() => { send({ type: 'ping', id: MY_ID, t: Date.now() }); }, 1000);
  setInterval(() => { if (prune()) { reassign(); if (MODE === 'host') updateFrame(); } updateBanner(); }, 1000);
  if (MODE === 'host') {
    setInterval(() => { send({ type: 'state', sv: SH.sv, ord: SH.ord, sw: SH.sw }); }, 500);
    setInterval(coordinator, 250);
    setInterval(() => { try { evalSweep(Date.now()); maybeAck(false); } catch (e) {} }, 100);
    let rzT = 0;
    window.addEventListener('resize', () => {
      resize(); clearTimeout(rzT);
      rzT = setTimeout(() => { hello(); updateFrame(); renderPanel(); }, 150);
    });
  } else {
    /* 业务状态：仅编号 0 的内容实例心跳（收敛源，防双写竞态） */
    setInterval(() => {
      if (psv > 0 && myIndex === 0 && adapter && adapter.getState && !applying) {
        let data; try { data = adapter.getState(); } catch (e) { return; }
        send({ type: 'page', psv, data });
      }
    }, 1000);
    window.addEventListener('resize', () => { setTimeout(() => hello(), 150); });
  }
  document.addEventListener('visibilitychange', () => {
    hello(document.hidden);
    reassign();
    if (MODE === 'host') maybeAck(true);
  });

  /* 适配器可能晚于壳注册：轮询拾取（inner 模式） */
  setInterval(() => {
    if (MODE !== 'host' && !adapter && window.ShellAdapter) {
      adapter = window.ShellAdapter;
      reassign();
      applyOffsetLocal(dispOffset);
      try { if (window.parent && window.parent !== window) window.parent.postMessage({ mws: 'ready' }, location.origin); } catch (e) {}
    }
  }, 200);

  /* ================= 启动 ================= */
  function boot() {
    if (MODE === 'host') {
      if (!document.body) { document.addEventListener('DOMContentLoaded', boot); return; }
      try { buildDom(); } catch (e) { console.warn('[MWS] 宿主 UI 构建失败', e); }
      hello(); reassign(); updateFrame(); pushShell();
      requestAnimationFrame(draw);
    } else {
      hello(); reassign();
    }
  }
  boot();

  MWS._test = { SH, hostGeom, myRect, liveIds, peers, evalSweep, mode: MODE };
})();
