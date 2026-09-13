// GET /api/visits?limit=300&since=<ms>  —— 返回最近的逐条访问记录
// 依赖 D1 绑定：DB
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '300', 10) || 300, 1), 1000);
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;

  let visits = [];
  try {
    const stmt = since
      ? env.DB.prepare(
          'SELECT ts,country,region,region_code,city,lat,lon,colo,path FROM visits WHERE ts > ? ORDER BY ts DESC LIMIT ?'
        ).bind(since, limit)
      : env.DB.prepare(
          'SELECT ts,country,region,region_code,city,lat,lon,colo,path FROM visits ORDER BY ts DESC LIMIT ?'
        ).bind(limit);
    const r = await stmt.all();
    visits = r.results || [];
  } catch (e) { /* 表不存在时返回空 */ }

  return new Response(JSON.stringify({ visits }), { headers: HEADERS });
}
