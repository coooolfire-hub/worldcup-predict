-- ============================================================
-- 世界杯预测社区 - D1 数据库 Schema
-- 设计原则：
--   1. 积分不可兑换、不可转让、不可提现 —— 所有积分变动都走 point_ledger，
--      永远不存在 user -> user 的直接转账路径。
--   2. 赔率（multiplier）在比赛开赛前由管理员设定一次，开赛后锁定，
--      不随实时押注资金量浮动 —— 这是和真实博彩盘口的核心区别。
--   3. 每场比赛的单用户押注上限写在 match_outcome_tiers.stake_cap，
--      不是写死在代码里，方便后续按监管要求调整而不用改代码。
-- ============================================================

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id TEXT UNIQUE NOT NULL,         -- 微信/手机号实名后的唯一标识
  nickname TEXT,
  points_balance INTEGER NOT NULL DEFAULT 0,  -- 缓存字段，真实账本以 point_ledger 为准
  last_daily_grant_date TEXT,           -- 'YYYY-MM-DD'，防止重复领取每日积分
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 比赛表
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_match_id TEXT UNIQUE NOT NULL,  -- 第三方体育数据API返回的比赛ID
  stage TEXT NOT NULL,                      -- '小组赛' / '十六分之一决赛' / '决赛' 等
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  kickoff_time INTEGER NOT NULL,            -- unix timestamp
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | live | finished | settled | cancelled
  home_score INTEGER,
  away_score INTEGER,
  tiers_locked_at INTEGER,                  -- 赔率锁定时间，一旦设置不可再改赔率
  settled_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 预测题型定义（胜平负 / 是否进球 / 总进球数区间 等）
CREATE TABLE IF NOT EXISTS prediction_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,    -- 'match_result' | 'both_teams_score' | 'total_goals_range'
  name TEXT NOT NULL,           -- 展示用名称，例如 "比赛结果预测"
  description TEXT
);

-- 每场比赛 x 每个题型 x 每个结果选项 的固定赔率档（开赛前设定，开赛后锁定）
CREATE TABLE IF NOT EXISTS match_outcome_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  prediction_type_id INTEGER NOT NULL REFERENCES prediction_types(id),
  outcome_key TEXT NOT NULL,      -- 'home_win' | 'draw' | 'away_win' | 'yes' | 'no' | '0-1' | '2-3' | '4+'
  outcome_label TEXT NOT NULL,    -- 展示用文案，例如 "巴西胜"
  multiplier REAL NOT NULL,       -- 固定回报倍率，例如 1.8 表示押100点中了拿180点
  stake_cap INTEGER NOT NULL DEFAULT 10000,  -- 单用户对这个结果的单局押注上限
  UNIQUE(match_id, prediction_type_id, outcome_key)
);

-- 用户的每一次预测下单
CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  match_id INTEGER NOT NULL REFERENCES matches(id),
  prediction_type_id INTEGER NOT NULL REFERENCES prediction_types(id),
  outcome_key TEXT NOT NULL,
  points_staked INTEGER NOT NULL,
  multiplier_locked REAL NOT NULL,   -- 下单那一刻锁定的倍率快照，即使后台数据后续被改也不受影响
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | won | lost | void
  points_awarded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  settled_at INTEGER
);

-- 积分账本 —— 唯一的真实积分变动来源，所有 balance 都是从这里汇总出来的
-- reason 枚举: 'daily_grant' | 'stake' | 'payout' | 'admin_adjust'
-- 注意：没有任何一行的 reason 是 'transfer_to_user'，这是产品层面刻意不提供该能力
CREATE TABLE IF NOT EXISTS point_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  change INTEGER NOT NULL,           -- 正数=增加，负数=减少
  reason TEXT NOT NULL,
  ref_table TEXT,                    -- 关联表名，例如 'predictions'
  ref_id INTEGER,                    -- 关联记录id
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 成就/称号
CREATE TABLE IF NOT EXISTS achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,         -- 'world_cup_oracle' | 'streak_5' | 'streak_10'
  name TEXT NOT NULL,                -- "世界杯先知"
  description TEXT,
  icon_url TEXT
);

CREATE TABLE IF NOT EXISTS user_achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  achievement_id INTEGER NOT NULL REFERENCES achievements(id),
  unlocked_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, achievement_id)
);

-- 连续命中 streak 追踪（每次结算后更新）
CREATE TABLE IF NOT EXISTS user_streaks (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_predictions_match ON predictions(match_id);
CREATE INDEX IF NOT EXISTS idx_predictions_user ON predictions(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON point_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
