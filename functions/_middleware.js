// 全站访问记录中间件：对 HTML 页面导航记录一次访问（服务端完成，无需前端脚本）。
// 去重策略：仅按「会话访客 id（Cookie tc_vid）+ 路径」去重——
//   无 Cookie 的首次访问一律计数（并下发 Cookie），此后同一浏览器在窗口内刷新同一路径只记一次；
//   不在服务端按 IP 兜底去重，否则同一 NAT/校园网出口下后来者会被前一位访客的记录误伤。
//   窗口由 VISIT_DEDUPE_MINUTES 控制（默认 30，0 = 关闭）。
// Cookie 为随机 id、仅用于本地去重，不跨站、不用于识别个人；每次访问最多写入一行。
// 依赖 D1 绑定：DB（visits.vid 列 + idx_visits_vid_path 索引）。
import { resolveGeo } from './_lib/geo.js';

const BOT_RE = /bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|headless|python-requests|curl|wget|monitor|uptime|pingdom|ahrefs|semrush|yandex|bytespider|petalbot/i;

const VID_COOKIE = 'tc_vid';
const VID_RE = /^[0-9a-f-]{16,64}$/i;

function cookieValue(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}

function newVid() {
  try { return crypto.randomUUID(); } catch (e) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }
}

function dedupeMinutes(env) {
  const n = Number(env.VISIT_DEDUPE_MINUTES);
  return Number.isFinite(n) ? Math.max(0, n) : 30;
}

async function record(context, vid, hasCookie, minutes) {
  const { request, env } = context;
  const ua = (request.headers.get('User-Agent') || '').slice(0, 400);
  if (BOT_RE.test(ua)) return;

  const { ip, geo, zh, colo } = await resolveGeo(request, env);
  const url = new URL(request.url);
  const ref = (request.headers.get('Referer') || '').slice(0, 300);

  if (minutes > 0 && hasCookie && vid) {
    try {
      const recent = await env.DB.prepare(
        'SELECT 1 AS x FROM visits WHERE vid = ? AND path = ? AND ts > ? LIMIT 1'
      ).bind(vid, url.pathname, Date.now() - minutes * 60 * 1000).first();
      if (recent) return;
    } catch (e) { /* 去重失败时继续记录 */ }
  }

  await env.DB.prepare(
    'INSERT INTO visits (ts,country,region,region_code,city,city_zh,region_zh,lat,lon,colo,ip,ua,path,ref,vid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    Date.now(), geo.country, geo.region, geo.region_code, geo.city, zh.city_zh, zh.region_zh,
    geo.lat, geo.lon, colo, ip, ua, url.pathname + url.search, ref, vid
  ).run();
}

export async function onRequest(context) {
  const { request, next } = context;
  const accept = request.headers.get('Accept') || '';
  const url = new URL(request.url);
  let setCookie = '';
  if (request.method === 'GET' && accept.includes('text/html') && !url.pathname.startsWith('/api/')) {
    const minutes = dedupeMinutes(context.env);
    const existing = cookieValue(request, VID_COOKIE);
    const hasCookie = VID_RE.test(existing);
    const vid = hasCookie ? existing : newVid();
    if (minutes > 0 && !hasCookie) {
      setCookie = VID_COOKIE + '=' + vid + '; Path=/; Max-Age=' + Math.max(600, Math.round(minutes * 60)) + '; SameSite=Lax; Secure';
    }
    context.waitUntil(record(context, vid, hasCookie, minutes).catch(() => {}));
  }
  const res = await next();
  if (!setCookie) return res;
  const headers = new Headers(res.headers);
  headers.append('Set-Cookie', setCookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
