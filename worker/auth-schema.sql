-- ============================================================
-- 登录系统 schema 补丁（邮箱+密码版，内测用）
-- 在已有 schema.sql 基础上执行
-- ============================================================

-- users 表补充邮箱、密码字段
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;
ALTER TABLE users ADD COLUMN created_via TEXT DEFAULT 'email';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 登录会话表（token -> user）
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 连续登录天数 + 最后登录日期（用于成就）。已存在则忽略报错。
ALTER TABLE users ADD COLUMN login_streak INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN last_login_date TEXT;
