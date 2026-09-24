// 共享地理工具：解析访客归属地 + 中文名（D1 缓存）
// 国内 IP 走国内源（ip9 / zxinc，省市与 ip138 一致）；其余用 Cloudflare 优先、ipwho.is 兜底；
// 中文名优先用国内源返回，缺失时再用 Nominatim 反查。
const FALLBACK = 'https://ipwho.is/';
const CN_API = 'https://ip9.com.cn/get?ip=';
const CN_API2 = 'https://ip.zxinc.org/api.php?type=json&ip=';
const CN_SENTINEL = 'CN'; // 写进 region_code 标记“这行是国内源解析的”

export function pick(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// 中国省级行政区 → 英文名（英文界面用，风格与其它国家一致）
const CN_PROV = {
  北京: 'Beijing', 天津: 'Tianjin', 上海: 'Shanghai', 重庆: 'Chongqing',
  河北: 'Hebei', 山西: 'Shanxi', 辽宁: 'Liaoning', 吉林: 'Jilin', 黑龙江: 'Heilongjiang',
  江苏: 'Jiangsu', 浙江: 'Zhejiang', 安徽: 'Anhui', 福建: 'Fujian', 江西: 'Jiangxi',
  山东: 'Shandong', 河南: 'Henan', 湖北: 'Hubei', 湖南: 'Hunan', 广东: 'Guangdong',
  海南: 'Hainan', 四川: 'Sichuan', 贵州: 'Guizhou', 云南: 'Yunnan', 陕西: 'Shaanxi',
  甘肃: 'Gansu', 青海: 'Qinghai', 台湾: 'Taiwan', 内蒙古: 'Inner Mongolia',
  广西: 'Guangxi', 西藏: 'Tibet', 宁夏: 'Ningxia', 新疆: 'Xinjiang',
  香港: 'Hong Kong', 澳门: 'Macau',
};
function enProv(p) {
  if (!p) return '';
  p = String(p);
  for (const k in CN_PROV) { if (p.indexOf(k) >= 0) return CN_PROV[k]; }
  return '';
}
// ip9 的 city_code 是城市拼音（xiangyang），转成英文书写形式（Xiangyang）
function enCity(code, fb) {
  if (!code) return fb || '';
  return String(code).replace(/(^|[\s\-_])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })]);
}

// 国内 IP：按省市准确性拿归属地（ip138 同级别），返回 {geo,zh} 或 null
async function cnLookup(ip, env) {
  if (!ip) return null;
  // 命中缓存（仅认 sentinel 行，避免复用旧 cf/ipwho.is 的粗粒度结果）
  try {
    const c = await env.DB.prepare('SELECT country,region,region_code,city,lat,lon FROM ip_geo WHERE ip = ?').bind(ip).first();
    if (c && c.region_code === CN_SENTINEL && (c.region || c.city)) {
      const key = [c.country, c.region, c.city].join('|');
      const n = await env.DB.prepare('SELECT city_zh,region_zh FROM geo_names WHERE k = ?').bind(key).first();
      if (n) return { geo: c, zh: n };
    }
  } catch (e) { /* 表不存在时忽略 */ }

  // 源1：ip9.com.cn（UTF-8 JSON，含经纬度）
  try {
    const r = await withTimeout(fetch(CN_API + encodeURIComponent(ip)), 4500);
    if (r.ok) {
      const d = (await r.json()).data;
      if (d && (d.prov || d.city)) {
        const geo = {
          country: String(d.country_code || 'cn').toUpperCase(),
          region: enProv(d.prov) || d.prov || '',
          region_code: CN_SENTINEL,
          city: enCity(d.city_code, d.city) || d.prov || '',
          lat: pick(d.lat), lon: pick(d.lng),
        };
        const zh = { city_zh: d.city || d.prov || '', region_zh: d.prov || '' };
        await cacheCn(env, ip, geo, zh);
        return { geo: geo, zh: zh };
      }
    }
  } catch (e) { /* 换下一个源 */ }

  // 源2：ip.zxinc.org（纯真库，UTF-8；无经纬度）
  try {
    const r = await withTimeout(fetch(CN_API2 + encodeURIComponent(ip)), 4500);
    if (r.ok) {
      const d = (await r.json()).data || {};
      const p = String(d.country || '').split(/[–—-]/);
      if (p.length >= 2) {
        const geo = { country: 'CN', region: enProv(p[1]) || p[1] || '', region_code: CN_SENTINEL, city: p[2] || p[1] || '', lat: null, lon: null };
        const zh = { city_zh: p[2] || p[1] || '', region_zh: p[1] || '' };
        await cacheCn(env, ip, geo, zh);
        return { geo: geo, zh: zh };
      }
    }
  } catch (e) { /* 全部失败则回退到 Cloudflare */ }
  return null;
}

async function cacheCn(env, ip, geo, zh) {
  try {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO ip_geo (ip,country,region,region_code,city,lat,lon,ts) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(ip, geo.country, geo.region, geo.region_code, geo.city, geo.lat, geo.lon, Date.now()).run();
    const key = [geo.country, geo.region, geo.city].join('|');
    await env.DB.prepare(
      'INSERT OR REPLACE INTO geo_names (k,city_zh,region_zh,ts) VALUES (?,?,?,?)'
    ).bind(key, zh.city_zh, zh.region_zh, Date.now()).run();
  } catch (e) { /* 忽略缓存写入失败 */ }
}

export async function fallbackGeo(ip, env) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return null;
  try {
    const cached = await env.DB.prepare('SELECT country,region,region_code,city,lat,lon FROM ip_geo WHERE ip = ?').bind(ip).first();
    if (cached && cached.region_code !== CN_SENTINEL) return cached;
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
    return { city_zh: city_zh, region_zh: region_zh };
  } catch (e) {
    return { city_zh: '', region_zh: '' };
  }
}

// 解析访客归属地：国内优先国内源；其余 Cloudflare 优先，缺 city 时用 ipwho.is；最后补中文名
export async function resolveGeo(request, env) {
  const cf = request.cf || {};
  const ip = request.headers.get('CF-Connecting-IP') || '';
  let geo = null, zh = null;

  if ((cf.country === 'CN' || !cf.country) && ip) {
    const hit = await cnLookup(ip, env);
    if (hit) { geo = hit.geo; zh = hit.zh; }
  }

  if (!geo) {
    geo = {
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
  }

  // 国内源可能没经纬度（zxinc），用 Cloudflare 的补上，保证地图有落点
  if (geo.lat == null) geo.lat = pick(cf.latitude);
  if (geo.lon == null) geo.lon = pick(cf.longitude);

  if (!zh) zh = await localize(geo, env);
  return { ip: ip, geo: geo, zh: zh, colo: cf.colo || '' };
}
