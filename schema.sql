-- Cloudflare D1 schema for teecatt visitor tracking.
-- Apply with:
--   npx wrangler d1 execute d2p-visits --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS visits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,   -- 毫秒时间戳
  country     TEXT,               -- Cloudflare country（如 CN / US）
  region      TEXT,               -- 省 / 州名称（英文）
  region_code TEXT,               -- ISO 3166-2（如 CN-GD）
  city        TEXT,               -- 城市（英文）
  city_zh     TEXT,               -- 城市（中文，Nominatim 懒加载）
  region_zh   TEXT,               -- 省 / 州（中文）
  lat         REAL,
  lon         REAL,
  colo        TEXT,               -- 落地的 Cloudflare 机房代码
  ip          TEXT,               -- 访客 IP
  vid         TEXT,               -- 会话访客 id（Cookie tc_vid），用于 NAT 后区分不同浏览器
  ua          TEXT,
  path        TEXT,
  ref         TEXT
);

CREATE INDEX IF NOT EXISTS idx_visits_ts     ON visits (ts DESC);
CREATE INDEX IF NOT EXISTS idx_visits_region ON visits (region_code, city);
CREATE INDEX IF NOT EXISTS idx_visits_city   ON visits (city);
CREATE INDEX IF NOT EXISTS idx_visits_vid_path ON visits (vid, path, ts DESC);

-- 第三方 IP 归属地缓存（避免重复调用 ipwho.is）
CREATE TABLE IF NOT EXISTS ip_geo (
  ip          TEXT PRIMARY KEY,
  country     TEXT,
  region      TEXT,
  region_code TEXT,
  city        TEXT,
  lat         REAL,
  lon         REAL,
  ts          INTEGER
);

-- 地名中英缓存（按 country|region|city 去重，用 Nominatim 反查中文）
CREATE TABLE IF NOT EXISTS geo_names (
  k           TEXT PRIMARY KEY,
  city_zh     TEXT,
  region_zh   TEXT,
  ts          INTEGER
);

-- 预聚合：位置 -> 次数。由 visits 的 AFTER INSERT 触发器增量维护（n = n + 1），
-- 供 /api/stats 直接读取，避免每次对 visits 明细做全表 COUNT/GROUP BY。
CREATE TABLE IF NOT EXISTS place_stats (
  k           TEXT PRIMARY KEY,   -- city|region|country
  city        TEXT,
  city_zh     TEXT,
  region      TEXT,
  region_zh   TEXT,
  region_code TEXT,
  country     TEXT,
  lat         REAL,
  lon         REAL,
  n           INTEGER,            -- 该位置累计访问次数
  ts          INTEGER
);

CREATE TRIGGER IF NOT EXISTS trg_visits_place AFTER INSERT ON visits
BEGIN
  INSERT INTO place_stats (k,city,city_zh,region,region_zh,region_code,country,lat,lon,n,ts)
  VALUES (NEW.city||'|'||IFNULL(NEW.region,'')||'|'||IFNULL(NEW.country,''), NEW.city, NEW.city_zh,
          NEW.region, NEW.region_zh, NEW.region_code, NEW.country, NEW.lat, NEW.lon, 1, NEW.ts)
  ON CONFLICT(k) DO UPDATE SET
    n = n + 1,
    ts        = excluded.ts,
    city_zh   = COALESCE(NULLIF(excluded.city_zh,''),   place_stats.city_zh),
    region_zh = COALESCE(NULLIF(excluded.region_zh,''), place_stats.region_zh),
    lat = COALESCE(excluded.lat, place_stats.lat),
    lon = COALESCE(excluded.lon, place_stats.lon);
END;

-- 去重查询索引：middleware 写入前按 (ip, path, ts) 判断 30 分钟窗口内是否已记录
CREATE INDEX IF NOT EXISTS idx_visits_ip_path ON visits (ip, path, ts DESC);

-- 升级已有库时执行（新装环境由上面的 CREATE 语句覆盖）：
--   ALTER TABLE visits ADD COLUMN vid TEXT;
--   CREATE INDEX IF NOT EXISTS idx_visits_vid_path ON visits (vid, path, ts DESC);
