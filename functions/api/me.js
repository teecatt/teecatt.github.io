// GET /api/me  —— 返回当前访客自己的归属地（含中文名与经纬度），用于页面显示「您来自」
import { resolveGeo } from '../_lib/geo.js';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};

export async function onRequestGet({ request, env }) {
  const { ip, geo, zh } = await resolveGeo(request, env);
  return new Response(JSON.stringify({
    ip,
    country: geo.country,
    region: geo.region,
    region_code: geo.region_code,
    city: geo.city,
    city_zh: zh.city_zh,
    region_zh: zh.region_zh,
    lat: geo.lat,
    lon: geo.lon,
  }), { headers: HEADERS });
}
