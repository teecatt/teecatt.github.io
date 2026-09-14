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
