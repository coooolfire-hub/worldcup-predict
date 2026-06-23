// ============================================================
// 邮箱 + 密码登录认证（内测版，替换掉短信验证码版）
//   POST /api/register  邮箱密码注册
//   POST /api/login     邮箱密码登录
//   GET  /api/session   用token恢复登录态
//
// 密码安全：用 PBKDF2 (Web Crypto 原生支持) 哈希，加随机盐，绝不存明文。
// 内测阶段不强制邮箱验证（降低朋友测试门槛），但预留了字段方便以后补。
// ============================================================

const SESSION_TTL = 30 * 24 * 3600;
const PBKDF2_ITERATIONS = 100000;

// ---------- 密码哈希 ----------
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}

async function verifyPassword(password, storedHash, storedSalt) {
  const { hash } = await hashPassword(password, storedSalt);
  // 恒定时间比较，避免时序攻击
  if (hash.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ storedHash.charCodeAt(i);
  return diff === 0;
}

function bytesToHex(bytes) { return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); }
function hexToBytes(hex) { const a = new Uint8Array(hex.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a; }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- 注册 ----------
export async function handleRegister(request, env) {
  const { email, password, nickname } = await request.json();
  if (!EMAIL_RE.test(email || '')) return jsonError('请输入正确的邮箱', 400);
  if (!password || password.length < 6) return jsonError('密码至少6位', 400);

  const db = env.DB;
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return jsonError('该邮箱已注册，请直接登录', 409);

  const { hash, salt } = await hashPassword(password);
  const openId = 'email_' + email;
  const nick = (nickname && nickname.trim()) || '先知' + Math.floor(1000 + Math.random() * 9000);

  const ins = await db
    .prepare(
      `INSERT INTO users (open_id, email, password_hash, password_salt, nickname, created_via, points_balance)
       VALUES (?, ?, ?, ?, ?, 'email', 0)`
    )
    .bind(openId, email, hash, salt, nick)
    .run();

  const userId = ins.meta.last_row_id;
  const token = await createSession(db, userId);
  return jsonOk({ token, userId, nickname: nick, pointsBalance: 0, isNewUser: true });
}

// ---------- 登录 ----------
export async function handleLogin(request, env) {
  const { email, password } = await request.json();
  if (!EMAIL_RE.test(email || '')) return jsonError('请输入正确的邮箱', 400);
  if (!password) return jsonError('请输入密码', 400);

  const db = env.DB;
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user || !user.password_hash) return jsonError('邮箱或密码错误', 401);

  const ok = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!ok) return jsonError('邮箱或密码错误', 401);

  const token = await createSession(db, user.id);
  return jsonOk({ token, userId: user.id, nickname: user.nickname, pointsBalance: user.points_balance });
}

// ---------- 用token恢复登录态 ----------
export async function handleSession(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || (request.headers.get('Authorization') || '').replace('Bearer ', '');
  if (!token) return jsonError('未登录', 401);

  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const session = await db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').bind(token, now).first();
  if (!session) return jsonError('登录已过期，请重新登录', 401);

  const user = await db.prepare('SELECT * FROM users WHERE id=?').bind(session.user_id).first();
  if (!user) return jsonError('用户不存在', 404);
  return jsonOk({ userId: user.id, nickname: user.nickname, pointsBalance: user.points_balance });
}

export async function getUserIdFromToken(request, env) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const s = await env.DB.prepare('SELECT user_id FROM sessions WHERE token=? AND expires_at>?').bind(token, now).first();
  return s ? s.user_id : null;
}

async function createSession(db, userId) {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .bind(token, userId, Math.floor(Date.now() / 1000) + SESSION_TTL).run();
  return token;
}

function jsonOk(body) { return new Response(JSON.stringify({ success: true, ...body }), { headers: { 'Content-Type': 'application/json' } }); }
function jsonError(message, status) { return new Response(JSON.stringify({ success: false, error: message }), { status, headers: { 'Content-Type': 'application/json' } }); }
