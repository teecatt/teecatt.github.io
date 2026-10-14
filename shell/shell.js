/* MWS — Multi-Window Shell（多窗口同步壳）v1.0
   完全解耦的组件式外壳：一行接入任意页面（含非纯前端页面的前端视图层）。
   <script src="../shell/shell.js"></script>

   页面可选提供适配器（提供前/后均可，壳会等待注册）：
     window.ShellAdapter = {
       getState():  object,            // 业务状态快照（JSON 可克隆），跨窗口中继
       applyState(data): void,         // 收到他窗状态时应用（壳保证不做重入广播）
       domain?: { lo, hi, label },     // 声明"均分域"（如 88 键 21..109），壳负责切片
       onAssign?(a): void,             // 分片回调 {index,count,slice}
       applyOffset?(ms): void          // 显示偏移补偿（物理显示延迟校正）
     };
   壳内状态（窗口互认/序号/扫描线/标定）与页面业务状态完全隔离，互不理解对方字段。

   扫描线（拼接画布模型）：
   - 横扫线：竖直线，按窗口像素宽度加权，#1→#N 逐窗接力（像素速度均匀）；
   - 纵扫线：水平线，每窗全高归一同步下扫，周期与横扫完全一致、同相位起扫；
   - 屏障：所有可见窗口确认两条线都走完（swdone）才生成下一根；
     窗口集合/序号/尺寸变化（geom 变更）立即重开一根。
*/
(function () {
  'use strict';
  if (window.__MWS) return;
  const MWS = window.__MWS = { version: '1.0' };

  /* ================= 身份与配置 ================= */
  const CH = 'mws.v1';
  const MY_ID = (crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now();
  const BORN = Date.now();
  const LEAD = 300;            // 新扫描线提前下发（ms）
  const ACK_TIMEOUT = 4000;    // 等所有窗口确认的超时兜底（ms）
  const LS = { offset: 'mws_offset', lines: 'mws_lines' };
  const on = (k, d) => { const v = localStorage.getItem(k); return v === null ? d : v !== '0'; };
  let linesOn = on(LS.lines, true);
  let dispOffset = Number(localStorage.getItem(LS.offset) || 0);

  /* 壳自身状态（sv 版本化广播） */
  const SH = { sv: 0, ord: {}, sw: null };   // sw: {cycle,startAt,T,segs:[{id,off,w}]}
  /* 页面业务状态中继（psv 版本化，壳不理解 data 内容） */
  let psv = 0, applying = false;

  let adapter = window.ShellAdapter || null;
  const assignCbs = [];
  let myIndex = 0, myCount = 1, mySlice = null;

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

  /* ================= 在场与编号 ================= */
  const peers = new Map();   // id -> {born,hidden,w,h,lastSeen}
  function myWH() { return { w: window.innerWidth || 1280, h: window.innerHeight || 720 }; }
  function hello(hidden) {
    const wh = myWH();
    send({ type: 'hello', id: MY_ID, born: BORN, hidden: hidden === undefined ? document.hidden : hidden, w: wh.w, h: wh.h });
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
    for (const id of ids) {                       // 手动序号优先（冲突按自动顺序先到先得）
      const f = Number(SH.ord[id]);
      if (!f) continue;
      const k = Math.min(n, Math.max(1, f)) - 1;
      if (slots[k] == null) { slots[k] = id; assigned.set(id, k); }
    }
    let fill = 0;                                  // 其余按自动顺序补位
    for (const id of ids) {
      if (assigned.has(id)) continue;
      while (fill < n && slots[fill] != null) fill++;
      if (fill >= n) break;
      slots[fill] = id; assigned.set(id, fill); fill++;
    }
    return { ids, idx: assigned.has(MY_ID) ? assigned.get(MY_ID) : ids.indexOf(MY_ID), n };
  }
  function sliceFor(k, n) {
    const d = adapter && adapter.domain;
    if (!d || !n) return null;
    const lo = d.lo + Math.floor((d.hi - d.lo) * k / n);
    const hi = d.lo + Math.floor((d.hi - d.lo) * (k + 1) / n);
    return { lo, hi };
  }
  function reassign() {
    const a = computeAssign();
    const sl = sliceFor(a.idx, a.n);
    const changed = a.idx !== myIndex || a.n !== myCount ||
      (sl ? (!mySlice || sl.lo !== mySlice.lo || sl.hi !== mySlice.hi) : !!mySlice);
    myIndex = a.idx; myCount = a.n; mySlice = sl;
    if (changed) {
      const payload = { index: myIndex, count: myCount, slice: mySlice };
      if (adapter && adapter.onAssign) { try { adapter.onAssign(payload); } catch (e) { console.warn(e); } }
      for (const cb of assignCbs) { try { cb(payload); } catch (e) {} }
      renderPanel(); renderSteps();
    }
    return changed;
  }

  /* ================= 扫描线：几何 / 屏障 / 绘制 ================= */
  const swAcks = new Map();   // cycle -> Set(id)
  let ackedCycle = -1, sawH = false, sawV = false, rttEma = 0;
  function onNewCycle() { ackedCycle = -1; sawH = false; sawV = false; }
  /* 扫描线时间求值（绘制与无 DOM 确认共用） */
  function evalSweep(now) {
    const sw = SH.sw;
    if (!linesOn || !sw) return null;
    const t = now - sw.startAt;
    if (t < 0 || t >= sw.T) return null;
    sawV = true;
    const seg = sw.segs.find(s => s.id === MY_ID);
    let hx = null;
    if (seg && sw.total > 0) {
      const s0 = (seg.off / sw.total) * sw.T;
      const s1 = ((seg.off + seg.w) / sw.total) * sw.T;
      if (t >= s0 && t < s1) { sawH = true; hx = ((t / sw.T) * sw.total - seg.off) / Math.max(1, seg.w) * W; }
    }
    return { t, y: (t / sw.T) * H, hx, T: sw.T };
  }

  function geom() {
    const ids = liveIds();
    const segs = []; let total = 0, maxw = 0;
    for (const id of ids) {
      const w = id === MY_ID ? myWH().w : (peers.get(id) && peers.get(id).w) || 1280;
      segs.push({ id, off: total, w });
      total += w; maxw = Math.max(maxw, w);
    }
    const T = Math.max(1500, Math.round(1000 * total / Math.max(1, maxw)));
    const sig = ids.map((id, i) => id.slice(0, 8) + ':' + Math.round(segs[i].w / 20)).join('|');
    return { segs, total, T, sig };
  }
  function startCycle(cycle, g, now) {
    SH.sw = { cycle, startAt: now + LEAD, T: g.T, segs: g.segs, sig: g.sig };
    pushShell();
    ackedCycle = -1; sawH = false; sawV = false;
    for (const k of [...swAcks.keys()]) if (k < cycle) swAcks.delete(k);
  }
  function localAck(cycle) {
    if (ackedCycle === cycle) return;
    ackedCycle = cycle; sawH = false; sawV = false;
    let s = swAcks.get(cycle); if (!s) { s = new Set(); swAcks.set(cycle, s); }
    s.add(MY_ID);
    send({ type: 'swdone', cycle });
  }
  function maybeAck(force) {
    const sw = SH.sw; if (!sw || ackedCycle === sw.cycle) return;
    const t = Date.now() - sw.startAt;
    if (t < sw.T) return;
    if ((sawH && sawV) || force || t > sw.T + 2500) localAck(sw.cycle);
  }
  function coordinator() {   // 仅 #1 运行：收齐确认/超时后生成下一根
    if (!linesOn || myIndex !== 0) return;
    const now = Date.now();
    const g = geom();
    const sw = SH.sw;
    if (!sw || sw.sig !== g.sig) { startCycle(sw ? sw.cycle + 1 : 0, g, now); return; }
    if (now < sw.startAt + sw.T) return;
    const acks = swAcks.get(sw.cycle) || new Set();
    const required = liveIds().filter(id => {
      const p = peers.get(id); return !(p && p.hidden);   // 后台标签不阻塞
    });
    const allDone = required.every(id => acks.has(id));
    if (allDone || now > sw.startAt + sw.T + ACK_TIMEOUT) {
      startCycle(sw.cycle + 1, g, now);
    }
  }

  /* ================= 页面适配器中继 ================= */
  function notifyPage() {
    if (!adapter || applying || !adapter.getState) return;
    let data; try { data = adapter.getState(); } catch (e) { return; }
    psv = Date.now();
    send({ type: 'page', psv, data });
  }
  MWS.notify = notifyPage;
  MWS.onAssign = cb => { assignCbs.push(cb); cb({ index: myIndex, count: myCount, slice: mySlice }); };
  MWS.assignment = () => ({ index: myIndex, count: myCount, slice: mySlice });
  MWS.setOffset = ms => { dispOffset = ms; localStorage.setItem(LS.offset, String(ms));
    if (adapter && adapter.applyOffset) { try { adapter.applyOffset(ms); } catch (e) {} } };

  onMsg(m => {
    if (m.type === 'hello') {
      peers.set(m.id, { born: m.born, hidden: !!m.hidden, w: m.w | 0 || 1280, h: m.h | 0 || 720, lastSeen: Date.now() });
      reassign();
    } else if (m.type === 'state') {
      if (m.sv <= SH.sv) return;
      const oldCycle = SH.sw ? SH.sw.cycle : -1;
      SH.sv = m.sv; SH.ord = (m.ord && typeof m.ord === 'object') ? m.ord : {};
      SH.sw = m.sw || null;
      if (!SH.sw || SH.sw.cycle !== oldCycle) onNewCycle();
      reassign(); renderPanel();
    } else if (m.type === 'page') {
      if (m.psv <= psv) return;
      psv = m.psv;
      if (adapter && adapter.applyState) {
        applying = true;
        try { adapter.applyState(m.data); } catch (e) { console.warn('[MWS] applyState', e); }
        finally { applying = false; }
      }
    } else if (m.type === 'swdone') {
      let s = swAcks.get(m.cycle); if (!s) { s = new Set(); swAcks.set(m.cycle, s); }
      s.add(m._from);
    } else if (m.type === 'ping') {
      send({ type: 'pong', to: m.id, t: m.t });
    } else if (m.type === 'pong' && m.to === MY_ID) {
      rttEma = rttEma ? rttEma * 0.7 + (Date.now() - m.t) * 0.3 : (Date.now() - m.t);
      const el = panelEls.rtt; if (el) el.textContent = rttEma.toFixed(1) + 'ms';
    }
  });
  function pushShell() { SH.sv = Date.now(); send(shellFields()); }
  function shellFields() { return { type: 'state', sv: SH.sv, ord: SH.ord, sw: SH.sw }; }

  /* ================= DOM（Shadow DOM，样式完全隔离） ================= */
  const panelEls = {};
  let shadow = null, cv = null, ctx = null, clockEl = null;
  let W = 0, H = 0, DPR = 1;
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
      #cv{position:absolute;inset:0;width:100%;height:100%}
      #clock{position:fixed;right:12px;top:10px;font-size:clamp(15px,2vw,24px);font-weight:700;
        letter-spacing:1px;color:rgba(230,237,243,.85);text-shadow:0 2px 8px #000;
        font-variant-numeric:tabular-nums}
      #panel{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);display:flex;gap:7px;
        align-items:center;flex-wrap:wrap;justify-content:center;max-width:96vw;padding:7px 11px;
        background:rgba(11,14,20,.9);border:1px solid #232a3a;border-radius:12px;
        backdrop-filter:blur(6px);pointer-events:auto;box-shadow:0 6px 24px rgba(0,0,0,.45)}
      .b{background:#1a2130;color:#cdd6f4;border:1px solid #2c3550;border-radius:6px;
        padding:4px 9px;font-size:13px;cursor:pointer}
      .b:hover{background:#253048}
      .badge{background:#1d3f2e;color:#6be49a;font-weight:700;font-size:12px;padding:4px 10px;
        border-radius:99px;white-space:nowrap}
      .s{font-size:12px;color:#9aa4bf;white-space:nowrap}
      .s b{color:#e6edf3}
      input[type=range]{accent-color:#3b7ddd;width:100px;vertical-align:middle}
      select{background:#1a2130;color:#cdd6f4;border:1px solid #2c3550;border-radius:6px;
        padding:3px 6px;font-size:13px}
      #banner{position:fixed;left:50%;top:10px;transform:translateX(-50%);display:none;gap:9px;
        align-items:center;background:#3f2f1d;border:1px solid #6b5526;color:#f0c674;
        border-radius:8px;padding:7px 13px;font-size:13px;max-width:92vw;pointer-events:auto}
      #steps{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
        background:rgba(5,7,11,.92);padding:20px;pointer-events:auto}
      #steps .card{max-width:680px;width:100%;background:#12161f;border:1px solid #262d40;
        border-radius:14px;padding:24px 28px;color:#cdd6f4}
      #steps h2{font-size:18px;margin-bottom:4px;color:#e6edf3}
      #steps .sub{font-size:13px;color:#9aa4bf;margin-bottom:14px}
      #steps ol{list-style:none;margin:0 0 16px}
      #steps li{padding:9px 12px;margin-bottom:8px;background:#171c28;border:1px solid #232a3a;
        border-radius:9px;font-size:13.5px;line-height:1.55}
      #steps li.ok{border-color:#2c5a3f}
      #steps .acts{display:flex;gap:9px;flex-wrap:wrap}
      #hint{position:fixed;right:10px;bottom:64px;font-size:11px;color:rgba(154,164,191,.8);
        text-align:right;max-width:46vw}
      @media(max-width:700px){#hint{display:none}}
    `;
    shadow.appendChild(st);
    cv = el(shadow, 'canvas', '');
    cv.id = 'cv';
    clockEl = el(shadow, 'div', '', '000000'); clockEl.id = 'clock';

    const banner = el(shadow, 'div', '', '<span id="bTxt"></span><button class="b" id="bOpen">拆成独立窗口</button><button class="b" id="bX">✕</button>');
    banner.id = 'banner';
    panelEls.bTxt = banner.querySelector('#bTxt');
    banner.querySelector('#bX').onclick = () => { bannerDismissed = true; try { sessionStorage.setItem('mws_banner_x', '1'); } catch (e) {} updateBanner(); };
    banner.querySelector('#bOpen').onclick = openWin;
    bannerDismissed = (() => { try { return sessionStorage.getItem('mws_banner_x') === '1'; } catch (e) { return false; } })();

    const p = el(shadow, 'div', ''); p.id = 'panel';
    p.innerHTML =
      '<span class="badge" id="pBadge">#1/1</span>' +
      '<span class="s" id="pSlice"></span>' +
      '<span class="s">序号<select id="pSeq"></select></span>' +
      '<button class="b" id="pLines" title="扫描线开关">✛ 线</button>' +
      '<span class="s">显示偏移<b id="pOff">+0ms</b><input type="range" id="pOffR" min="-300" max="300" step="4" value="0"></span>' +
      '<span class="s">RTT <b id="pRtt">–</b></span>' +
      '<button class="b" id="pOpen">＋ 开窗</button>' +
      '<button class="b" id="pFull">⛶</button>' +
      '<button class="b" id="pHelp">?</button>';
    for (const [k, id] of [['badge', 'pBadge'], ['slice', 'pSlice'], ['seq', 'pSeq'], ['lines', 'pLines'],
      ['off', 'pOff'], ['offR', 'pOffR'], ['rtt', 'pRtt'], ['open', 'pOpen'], ['full', 'pFull'], ['help', 'pHelp']]) {
      panelEls[k] = p.querySelector('#' + id);
    }
    panelEls.offR.value = String(dispOffset);
    panelEls.off.textContent = (dispOffset >= 0 ? '+' : '') + dispOffset + 'ms';
    panelEls.lines.textContent = linesOn ? '✛ 线' : '▢ 线';
    panelEls.open.onclick = openWin;
    panelEls.full.onclick = () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); };
    panelEls.help.onclick = () => { stepsEl.style.display = 'flex'; renderSteps(); };
    panelEls.lines.onclick = () => { linesOn = !linesOn; localStorage.setItem(LS.lines, linesOn ? '1' : '0');
      panelEls.lines.textContent = linesOn ? '✛ 线' : '▢ 线'; if (linesOn) { ackedCycle = -1; sawH = false; sawV = false; } };
    panelEls.offR.oninput = e => MWS.setOffset(Number(e.target.value));
    panelEls.seq.onchange = e => {
      const v = Number(e.target.value);
      if (!v) delete SH.ord[MY_ID];
      else {
        const other = liveIds().find(id => id !== MY_ID && Number(SH.ord[id]) === v);
        if (other) SH.ord[other] = myIndex + 1;   // 占用对调
        SH.ord[MY_ID] = v;
      }
      pushShell(); reassign(); renderPanel();
    };

    const hint = el(shadow, 'div', '', '纵线：各窗同相位全高下扫（比对大字钟读数差 = 显示延迟差，填入显示偏移）<br>横线：按宽度接力横扫拼接面（验证顺序与缝隙连续性）');
    hint.id = 'hint';

    stepsEl = el(shadow, 'div', ''); stepsEl.id = 'steps';
    stepsEl.innerHTML =
      '<div class="card"><h2>🧩 多窗口同步壳</h2>' +
      '<div class="sub">同浏览器再开一个本页窗口即自动互认 → 编号 → 标定 → 联动；扫描线把所有屏视为一块画布</div>' +
      '<ol><li id="s1"></li><li id="s2"></li><li id="s3"></li></ol>' +
      '<div class="acts"><button class="b" id="sDone">✓ 开始使用</button>' +
      '<button class="b" id="sOpen">＋ 再开一个窗口</button>' +
      '<button class="b" id="sSolo">单窗直接开始</button></div>' +
      '<div class="sub" style="margin-top:12px">多屏请用<b>独立窗口</b>分屏，<b>首次在每个窗口点一下</b>（解锁音频时钟）；后台标签会被浏览器冻结</div></div>';
    stepsEl.querySelector('#sDone').onclick = () => stepsEl.style.display = 'none';
    stepsEl.querySelector('#sSolo').onclick = () => stepsEl.style.display = 'none';
    stepsEl.querySelector('#sOpen').onclick = openWin;
    stepsEl.addEventListener('click', e => { if (e.target === stepsEl) stepsEl.style.display = 'none'; });

    (document.body || document.documentElement).appendChild(host);
    ctx = cv.getContext('2d');
    renderPanel(); renderSteps(); resize();
  }
  let stepsEl = null, bannerDismissed = false;
  function renderPanel() {
    if (!shadow) return;
    panelEls.badge.textContent = '#' + (myIndex + 1) + ' / ' + myCount + ' 窗';
    const d = adapter && adapter.domain;
    panelEls.slice.textContent = (mySlice && d)
      ? (d.label || '域') + ' ' + noteName(d, mySlice.lo) + '–' + noteName(d, mySlice.hi - 1) + '（' + (mySlice.hi - mySlice.lo) + '）'
      : '';
    let html = '<option value="">自动</option>';
    for (let i = 1; i <= myCount; i++) html += '<option value="' + i + '">#' + i + '</option>';
    if (panelEls.seq.innerHTML !== html) panelEls.seq.innerHTML = html;
    const f = Number(SH.ord[MY_ID]);
    panelEls.seq.value = f ? String(Math.min(myCount, Math.max(1, f))) : '';
  }
  function noteName(d, n) {   // 通用：MIDI 音名；非 MIDI 域直接显示数字
    if (d.label !== '键' && d.label !== undefined && !d.midi) return String(n);
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return names[n % 12] + (Math.floor(n / 12) - 1);
  }
  function renderSteps() {
    if (!stepsEl || stepsEl.style.display === 'none') return;
    const s1 = stepsEl.querySelector('#s1'), s2 = stepsEl.querySelector('#s2'), s3 = stepsEl.querySelector('#s3');
    if (myCount >= 2) {
      s1.className = 'ok';
      s1.innerHTML = '① <b>互认：</b>✅ 已识别本机 <b>' + myCount + '</b> 个窗口';
      s2.className = 'ok';
      s2.innerHTML = '② <b>编号：</b>✅ 本窗 <b>#' + (myIndex + 1) + '</b>' +
        (mySlice ? ' → 分片 ' + noteName(adapter.domain, mySlice.lo) + '–' + noteName(adapter.domain, mySlice.hi - 1) : '') +
        '（序号下拉可手动改号/对调）';
    } else {
      s1.className = ''; s1.innerHTML = '① <b>互认：</b>等待第二个窗口…（点「＋开窗」或再开一个本页）';
      s2.className = ''; s2.innerHTML = '② <b>编号：</b>单窗 = #1' + (adapter && adapter.domain ? '，独占全部域' : '');
    }
    s3.className = '';
    s3.innerHTML = '③ <b>标定：</b>纵线同相位下扫 → 手机拍两窗读<b>大字钟</b>毫秒差 = 显示延迟差 → 填「显示偏移」；横线接力横扫验证拼接；两线同周期，收齐所有窗口确认才出下一根';
  }
  function updateBanner() {
    if (!shadow) return;
    const b = shadow.querySelector('#banner');    let hidden = 0;
    for (const [, p] of peers) if (p.hidden) hidden++;
    if (!bannerDismissed && hidden > 0 && myCount > 1) {
      panelEls.bTxt.textContent = '有窗口在后台标签（渲染被冻结）。请用「拆成独立窗口」分屏：';
      b.style.display = 'flex';
    } else b.style.display = 'none';
  }
  function openWin() { window.open(location.href, '_blank', 'width=1000,height=660,menubar=no,toolbar=no'); }

  /* ================= 绘制循环 ================= */
  function resize() {
    if (!cv) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    if (ctx) ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  function draw() {
    const now = Date.now();
    if (ctx) {
      ctx.clearRect(0, 0, W, H);
      /* 水印 */
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(230,237,243,.13)';
      ctx.font = '700 ' + Math.min(96, H * 0.13) + 'px system-ui';
      ctx.fillText('#' + (myIndex + 1), 14, 118);
      ctx.fillStyle = 'rgba(154,164,191,.55)';
      ctx.font = '13px system-ui';
      const lbl = (mySlice && adapter && adapter.domain)
        ? noteName(adapter.domain, mySlice.lo) + '–' + noteName(adapter.domain, mySlice.hi - 1)
        : (myCount + ' 窗');
      ctx.fillText('#' + (myIndex + 1) + '/' + myCount + ' · ' + lbl, 16, 142);

      /* 扫描线 */
      const sw = SH.sw;
      if (linesOn && sw) {
        const s = evalSweep(now);
        if (s) {
          ctx.strokeStyle = 'rgba(255,255,255,.92)';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(0, s.y); ctx.lineTo(W, s.y); ctx.stroke();   // 纵线：全高归一下扫
          if (s.hx !== null) { ctx.beginPath(); ctx.moveTo(s.hx, 0); ctx.lineTo(s.hx, H); ctx.stroke(); } // 横线：接力段
        }
      }
      maybeAck(false);
    }
    if (clockEl) clockEl.textContent = String(now % 1000000).padStart(6, '0');
    requestAnimationFrame(draw);
  }

  /* ================= 定时器 ================= */
  setInterval(() => { hello(); }, 800);
  setInterval(() => { send(shellFields()); }, 500);
  setInterval(() => { if (psv > 0 && adapter && adapter.getState && !applying) {
    let data; try { data = adapter.getState(); } catch (e) { return; }
    send({ type: 'page', psv, data });
  } }, 1000);
  setInterval(() => send({ type: 'ping', id: MY_ID, t: Date.now() }), 1000);
  setInterval(coordinator, 250);
  setInterval(() => { try { evalSweep(Date.now()); maybeAck(false); } catch (e) {} }, 100); // 确认不依赖 rAF
  setInterval(() => { if (prune()) reassign(); updateBanner(); }, 1000);
  document.addEventListener('visibilitychange', () => {
    hello(document.hidden);
    reassign();
    maybeAck(true);   // 从后台回来时若当前轮已结束：直接补确认
  });
  window.addEventListener('resize', () => { resize(); });
  window.addEventListener('keydown', e => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === '?') panelEls.help && panelEls.help.click();
  });

  /* 适配器可能晚于壳注册：轮询拾取 + 应用偏移 */
  setInterval(() => {
    if (!adapter && window.ShellAdapter) {
      adapter = window.ShellAdapter;
      reassign();
      if (adapter.applyOffset && dispOffset) { try { adapter.applyOffset(dispOffset); } catch (e) {} }
    }
  }, 200);

  /* ================= 启动 ================= */
  function boot() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', boot); return; }
    buildDom();
    hello();
    reassign();
    pushShell();
    requestAnimationFrame(draw);
  }
  boot();
  MWS._test = { SH, peers, geom, liveIds };   // 测试钩子（只读）
})();
