// 共享地理工具：解析访客归属地 + 中文名（Nominatim 懒加载，D1 缓存）
const FALLBACK = 'https://ipwho.is/';

export function pick(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export async function fallbackGeo(ip, env) {
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

export async function localize(geo, env) {
  if (!geo.city && !geo.region) return { city_zh: '', region_zh: '' };
  const key = [geo.country, geo.region, geo.city].join('|');
  try {
    const cached = await env.DB.prepare('SELECT city_zh,region_zh FROM geo_names WHERE k = ?').bind(key).first();
    if (cached) return cached;
  } catch (e) { /* 表不存在时忽略 */ }
  if (geo.lat == null || geo.lon == null) return { city_zh: '', region_zh: '' };
  try {
    const u = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=zh-CN&lat=' + geo.lat + '&lon=' + geo.lon;
    const res = await fetch(u, { headers: { 'User-Agent': 'teecatt-visitor-map/1.0 (+https://down2.top)', 'Accept': 'application/json' } });
    if (!res.ok) return { city_zh: '', region_zh: '' };
    const d = await res.json();
    const a = d.address || {};
    // 直接采用 Nominatim 按 accept-language 返回的名字：有中文则中文，否则返回当地文字（阿拉伯语/蒙古语等），绝不回退英语。
    const city_zh = a.city || a.town || a.village || a.municipality || a.county || a.city_district || a.suburb || a.borough || a.quarter || a.neighbourhood || a.hamlet || d.name || '';
    const region_zh = a.state || a.province || a.region || a.state_district || '';
    try {
      await env.DB.prepare('INSERT OR REPLACE INTO geo_names (k,city_zh,region_zh,ts) VALUES (?,?,?,?)')
        .bind(key, city_zh, region_zh, Date.now()).run();
    } catch (e) { /* 忽略缓存写入失败 */ }
    return { city_zh, region_zh };
  } catch (e) {
    return { city_zh: '', region_zh: '' };
  }
}

// 解析访客归属地：Cloudflare 优先，缺 city 时用 ipwho.is，最后补中文名
export async function resolveGeo(request, env) {
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
  const zh = await localize(geo, env);
  return { ip, geo, zh, colo: cf.colo || '' };
}
