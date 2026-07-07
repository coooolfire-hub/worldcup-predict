-- ============================================================
-- 赛事级市场 schema 补丁（夺冠预测、金靴等整届赛事市场）
-- 这类市场不绑定单场比赛，整届赛事结束才结算，所以单独建表，
-- 不复用 matches / predictions（那两张是单场比赛用的）。
-- ============================================================

-- 赛事级市场（一届世界杯通常就 1 个 champion 市场 + 1 个 top_scorer 市场）
CREATE TABLE IF NOT EXISTS event_markets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_code TEXT NOT NULL,         -- 'champion' | 'top_scorer'
  title TEXT NOT NULL,               -- "谁能夺得本届世界杯冠军？"
  status TEXT NOT NULL DEFAULT 'open', -- open | settled | cancelled
  tiers_locked_at INTEGER,
  winner_key TEXT,                   -- 结算后填入获胜选项的 key
  settled_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 赛事级市场的选项 + 赔率（如32支球队各一个夺冠选项）
CREATE TABLE IF NOT EXISTS event_market_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL REFERENCES event_markets(id),
  outcome_key TEXT NOT NULL,         -- 球队id 或 球员id
  outcome_label TEXT NOT NULL,       -- "阿根廷" / "梅西"
  multiplier REAL NOT NULL,
  stake_cap INTEGER NOT NULL DEFAULT 10000,
  UNIQUE(market_id, outcome_key)
);

-- 用户对赛事级市场的预测
CREATE TABLE IF NOT EXISTS event_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  market_id INTEGER NOT NULL REFERENCES event_markets(id),
  outcome_key TEXT NOT NULL,
  points_staked INTEGER NOT NULL,
  multiplier_locked REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | won | lost | void
  points_awarded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  settled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_evpred_market ON event_predictions(market_id);
CREATE INDEX IF NOT EXISTS idx_evpred_user ON event_predictions(user_id);

-- 截止下注时间（unix时间戳，到点后停止下注）。已存在则忽略报错。
ALTER TABLE event_markets ADD COLUMN close_time INTEGER;
