-- Cloudflare D1 schema for teecatt visitor tracking.
-- Apply with:
--   npx wrangler d1 execute d2p-visits --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS visits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,   -- 毫秒时间戳
  country     TEXT,               -- Cloudflare country（如 CN / US）
  region      TEXT,               -- 省 / 州名称
  region_code TEXT,               -- ISO 3166-2（如 CN-GD）
  city        TEXT,               -- 城市（CF 缺失时用第三方兜底）
  lat         REAL,
  lon         REAL,
  colo        TEXT,               -- 落地的 Cloudflare 机房代码
  ip          TEXT,              -- 访客 IP
  ua          TEXT,
  path        TEXT,
  ref         TEXT
);

CREATE INDEX IF NOT EXISTS idx_visits_ts     ON visits (ts DESC);
CREATE INDEX IF NOT EXISTS idx_visits_region ON visits (region_code, city);
CREATE INDEX IF NOT EXISTS idx_visits_city   ON visits (city);

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
