// GET /api/visits?limit=300[&since=ts][&purge=days]  —— 仅管理员：逐条访问（含城市、时间、页面）
// 鉴权：优先读取 X-Admin-Key 或 Authorization: Bearer 头（密钥不再推荐放 query，避免进入日志）；
// 兼容 ?key= 作为过渡；需要 Pages 环境变量 ADMIN_KEY，否则一律 403。
// purge=N 时顺带删除 N 天前的明细，供定期清理调用（visits 不再无限增长）。
// 依赖 D1 绑定：DB
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-admin-key',
};

// 恒定时间字符串比较：避免逐字符短路带来的长度/前缀时序侧信道
function safeEqual(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return r === 0;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.replace(/^Bearer\s+/i, '');
  const key = request.headers.get('X-Admin-Key') || bearer || url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || !safeEqual(key, env.ADMIN_KEY)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: HEADERS });
  }

  // 保留期清理：purge=N 删除 N 天前的明细（配合定期请求调用）
  const purgeDays = parseInt(url.searchParams.get('purge') || '0', 10) || 0;
  let purged = 0;
  if (purgeDays > 0) {
    try {
      const r = await env.DB.prepare('DELETE FROM visits WHERE ts < ?').bind(Date.now() - purgeDays * 86400000).run();
      purged = (r.meta && r.meta.changes) || 0;
    } catch (e) { /* 表不存在时忽略 */ }
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

  return new Response(JSON.stringify({ visits, purged }), { headers: HEADERS });
}
