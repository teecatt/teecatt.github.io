// GET /api/stats  —— 返回总量、按省/国聚合、按城市聚合
// 依赖 D1 绑定：DB
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};

export async function onRequestGet({ env }) {
  let total = 0;
  let regions = [];
  let cities = [];
  try {
    const t = await env.DB.prepare('SELECT COUNT(*) AS n FROM visits').first();
    total = t ? t.n : 0;

    const r = await env.DB.prepare(
      `SELECT COALESCE(NULLIF(region_code,''),'')              AS code,
              COALESCE(NULLIF(region,''), NULLIF(country,''), '未知') AS name,
              COALESCE(NULLIF(country,''), '')                 AS country,
              COUNT(*)                                          AS n,
              MAX(ts)                                           AS last,
              AVG(lat)                                          AS lat,
              AVG(lon)                                          AS lon
       FROM visits
       GROUP BY code, name, country
       ORDER BY n DESC
       LIMIT 500`
    ).all();
    regions = r.results || [];

    const c = await env.DB.prepare(
      `SELECT COALESCE(NULLIF(city,''), '未知')                   AS city,
              COALESCE(NULLIF(region,''), NULLIF(country,''), '') AS region,
              COUNT(*)                                           AS n,
              MAX(ts)                                            AS last,
              AVG(lat)                                           AS lat,
              AVG(lon)                                           AS lon
       FROM visits
       GROUP BY city, region
       ORDER BY n DESC
       LIMIT 500`
    ).all();
    cities = c.results || [];
  } catch (e) { /* 表不存在时返回空 */ }

  return new Response(JSON.stringify({ total, regions, cities }), { headers: HEADERS });
}
