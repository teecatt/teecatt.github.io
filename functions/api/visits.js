// GET /api/visits?limit=300&key=<ADMIN_KEY>  —— 仅管理员：逐条访问（含城市、时间、页面）
// 需要 Pages 环境变量 ADMIN_KEY；否则一律 403。
// 依赖 D1 绑定：DB
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: HEADERS });
  }

  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '300', 10) || 300, 1), 1000);
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;

  let visits = [];
  try {
    const stmt = since
      ? env.DB.prepare(
          'SELECT ts,country,region,region_code,city,city_zh,region_zh,lat,lon,colo,ip,path FROM visits WHERE ts > ? ORDER BY ts DESC LIMIT ?'
        ).bind(since, limit)
      : env.DB.prepare(
          'SELECT ts,country,region,region_code,city,city_zh,region_zh,lat,lon,colo,ip,path FROM visits ORDER BY ts DESC LIMIT ?'
        ).bind(limit);
    const r = await stmt.all();
    visits = r.results || [];
  } catch (e) { /* 表不存在时返回空 */ }

  return new Response(JSON.stringify({ visits }), { headers: HEADERS });
}
