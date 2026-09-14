// GET /api/stats  —— 公开：总量 + 按省/国聚合 + 按城市聚合（只有地点与次数，不含时间）
// 依赖 D1 绑定：DB
// 读预聚合表 place_stats（写入时由 D1 触发器 trg_visits_place 增量维护 n+1），
// 不再对 visits 明细做全表 COUNT/GROUP BY —— 读行数只与不同地点数相关。
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
    const t = await env.DB.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM place_stats').first();
    total = t ? t.n : 0;

    const r = await env.DB.prepare(
      `SELECT COALESCE(NULLIF(region_code,''),'')              AS code,
              COALESCE(NULLIF(region,''), NULLIF(country,''), '未知') AS name,
              COALESCE(NULLIF(country,''), '')                 AS country,
              MAX(region_zh)                                   AS region_zh,
              SUM(n)                                           AS n,
              AVG(lat)                                         AS lat,
              AVG(lon)                                         AS lon
       FROM place_stats
       GROUP BY code, name, country
       ORDER BY n DESC
       LIMIT 500`
    ).all();
    regions = r.results || [];

    const c = await env.DB.prepare(
      `SELECT city, region, country, city_zh, region_zh, n, lat, lon
       FROM place_stats
       ORDER BY n DESC
       LIMIT 500`
    ).all();
    cities = c.results || [];
  } catch (e) { /* 表不存在时返回空 */ }

  return new Response(JSON.stringify({ total, regions, cities }), { headers: HEADERS });
}
