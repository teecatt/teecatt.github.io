// 全站访问记录中间件：对 HTML 页面导航记录一次访问（服务端完成，无需前端脚本）
// 依赖 D1 绑定：DB
import { resolveGeo } from './_lib/geo.js';

const BOT_RE = /bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|headless|python-requests|curl|wget|monitor|uptime|pingdom|ahrefs|semrush|yandex|bytespider|petalbot/i;

async function record(context) {
  const { request, env } = context;
  const ua = (request.headers.get('User-Agent') || '').slice(0, 400);
  if (BOT_RE.test(ua)) return;

  const { ip, geo, zh, colo } = await resolveGeo(request, env);
  const url = new URL(request.url);
  const ref = (request.headers.get('Referer') || '').slice(0, 300);

  // 同一 IP + 同一路径的去重窗口：默认 30 分钟，可用 Pages 环境变量 VISIT_DEDUPE_MINUTES 调整
  //（0 = 关闭去重，每次 HTML 导航都计数）。索引 idx_visits_ip_path 支撑该查询；
  // 查询失败（表/索引缺失）时忽略去重，不阻断记录。
  const dedupeMinutes = Number.isFinite(Number(env.VISIT_DEDUPE_MINUTES))
    ? Math.max(0, Number(env.VISIT_DEDUPE_MINUTES))
    : 30;
  if (ip && dedupeMinutes > 0) {
    try {
      const recent = await env.DB.prepare(
        'SELECT 1 AS x FROM visits WHERE ip = ? AND path = ? AND ts > ? LIMIT 1'
      ).bind(ip, url.pathname, Date.now() - dedupeMinutes * 60 * 1000).first();
      if (recent) return;
    } catch (e) { /* 去重失败时继续记录 */ }
  }

  await env.DB.prepare(
    'INSERT INTO visits (ts,country,region,region_code,city,city_zh,region_zh,lat,lon,colo,ip,ua,path,ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    Date.now(), geo.country, geo.region, geo.region_code, geo.city, zh.city_zh, zh.region_zh,
    geo.lat, geo.lon, colo, ip, ua, url.pathname + url.search, ref
  ).run();
}

export async function onRequest(context) {
  const { request, next } = context;
  const accept = request.headers.get('Accept') || '';
  const url = new URL(request.url);
  if (request.method === 'GET' && accept.includes('text/html') && !url.pathname.startsWith('/api/')) {
    context.waitUntil(record(context).catch(() => {}));
  }
  return next();
}
