// 全站访问记录中间件：对 HTML 页面导航记录一次访问（服务端完成，无需前端脚本）
// 依赖 D1 绑定：DB
const FALLBACK = 'https://ipwho.is/';
const BOT_RE = /bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|headless|python-requests|curl|wget|monitor|uptime|pingdom|ahrefs|semrush|yandex|bytespider|petalbot/i;

function pick(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function fallbackGeo(ip, env) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return null;
  try {
    const cached = await env.DB.prepare('SELECT country,region,region_code,city,lat,lon FROM ip_geo WHERE ip = ?').bind(ip).first();
    if (cached) return cached;
  } catch (e) { /* 表不存在时忽略 */ }
  try {
    const res = await fetch(FALLBACK + encodeURIComponent(ip), { cf: { cacheTtl: 86400 } });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || d.success === false) return null;
    const geo = {
      country: d.country_code || '',
      region: d.region || '',
      region_code: d.region_code || '',
      city: d.city || '',
      lat: typeof d.latitude === 'number' ? d.latitude : null,
      lon: typeof d.longitude === 'number' ? d.longitude : null,
    };
    try {
      await env.DB.prepare(
        'INSERT OR REPLACE INTO ip_geo (ip,country,region,region_code,city,lat,lon,ts) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(ip, geo.country, geo.region, geo.region_code, geo.city, geo.lat, geo.lon, Date.now()).run();
    } catch (e) { /* 忽略缓存写入失败 */ }
    return geo;
  } catch (e) {
    return null;
  }
}

async function record(context) {
  const { request, env } = context;
  const ua = (request.headers.get('User-Agent') || '').slice(0, 400);
  if (BOT_RE.test(ua)) return;

  const cf = request.cf || {};
  const ip = request.headers.get('CF-Connecting-IP') || '';

  let geo = {
    country: cf.country || '',
    region: cf.region || '',
    region_code: cf.regionCode || '',
    city: cf.city || '',
    lat: pick(cf.latitude),
    lon: pick(cf.longitude),
  };

  // Cloudflare 对国内 IP 常缺 city，用第三方兜底补全省/市
  if (!geo.city && ip) {
    const fb = await fallbackGeo(ip, env);
    if (fb) {
      geo = {
        country: geo.country || fb.country,
        region: geo.region || fb.region,
        region_code: geo.region_code || fb.region_code,
        city: fb.city || geo.city,
        lat: geo.lat != null ? geo.lat : fb.lat,
        lon: geo.lon != null ? geo.lon : fb.lon,
      };
    }
  }

  const url = new URL(request.url);
  const ref = (request.headers.get('Referer') || '').slice(0, 300);

  await env.DB.prepare(
    'INSERT INTO visits (ts,country,region,region_code,city,lat,lon,colo,ip,ua,path,ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    Date.now(), geo.country, geo.region, geo.region_code, geo.city,
    geo.lat, geo.lon, cf.colo || '', ip, ua, url.pathname + url.search, ref
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
