// ============================================================
// 后台：用户管理
//   POST /api/admin/list-users    列出所有用户
//   POST /api/admin/delete-user   删除用户（连带清理其所有数据）
// ============================================================

export async function handleListUsers(request, env) {
  const db = env.DB;
  const rows = await db.prepare(
    `SELECT u.id, u.email, u.nickname, u.points_balance, u.created_at,
            (SELECT COUNT(*) FROM predictions p WHERE p.user_id=u.id) AS bet_count
     FROM users u ORDER BY u.id DESC`
  ).all();
  return jsonOk({ users: rows.results });
}

export async function handleDeleteUser(request, env) {
  const { userId } = await request.json();
  const db = env.DB;
  if (!userId) return jsonError('缺少 userId', 400);

  const user = await db.prepare('SELECT id, email FROM users WHERE id=?').bind(userId).first();
  if (!user) return jsonError('用户不存在', 404);

  // 连带清理该用户的所有数据，避免孤儿记录
  await db.prepare('DELETE FROM predictions WHERE user_id=?').bind(userId).run();
  await db.prepare('DELETE FROM event_predictions WHERE user_id=?').bind(userId).run();
  await db.prepare('DELETE FROM point_ledger WHERE user_id=?').bind(userId).run();
  await db.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId).run();
  await db.prepare('DELETE FROM users WHERE id=?').bind(userId).run();

  return jsonOk({ message: `已删除用户 ${user.email}（及其所有记录）` });
}

// 给用户发放/调整积分（amount 可正可负；正=发放，负=扣除）
export async function handleGrantPoints(request, env) {
  const { userId, amount } = await request.json();
  const db = env.DB;
  if (!userId || !Number.isInteger(amount) || amount === 0) {
    return jsonError('需要 userId 和非零整数 amount', 400);
  }
  const user = await db.prepare('SELECT id, email, points_balance FROM users WHERE id=?').bind(userId).first();
  if (!user) return jsonError('用户不存在', 404);

  // 扣除时不允许扣成负数
  if (amount < 0 && user.points_balance + amount < 0) {
    return jsonError(`余额不足（当前 ${user.points_balance}，无法扣除 ${-amount}）`, 400);
  }

  await db.prepare('UPDATE users SET points_balance = points_balance + ? WHERE id=?').bind(amount, userId).run();
  await db.prepare(`INSERT INTO point_ledger (user_id, change, reason) VALUES (?, ?, 'admin_grant')`).bind(userId, amount).run();

  const newBalance = user.points_balance + amount;
  return jsonOk({ message: `已${amount > 0 ? '发放' : '扣除'} ${Math.abs(amount)} 点，${user.email} 当前 ${newBalance} 点`, newBalance });
}

function jsonOk(body) { return new Response(JSON.stringify({ success: true, ...body }), { headers: { 'Content-Type': 'application/json' } }); }
function jsonError(message, status) { return new Response(JSON.stringify({ success: false, error: message }), { status, headers: { 'Content-Type': 'application/json' } }); }
