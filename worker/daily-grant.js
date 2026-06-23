// ============================================================
// 每日登录发放积分
// 在用户打开App/网站时调用，而不是用cron批量发——这样不用猜用户什么时候
// 会登录，且天然实现"不登录就不发"的逻辑，省一张表。
// ============================================================

const DAILY_GRANT_AMOUNT = 1000;

export async function handleDailyGrant(request, env) {
  const { userId } = await request.json();
  const db = env.DB;

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!user) {
    return new Response(JSON.stringify({ success: false, error: '用户不存在' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'，按服务器时区，上线前确认是否要换成北京时间

  if (user.last_daily_grant_date === today) {
    return new Response(
      JSON.stringify({ success: true, granted: false, balance: user.points_balance }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  await db
    .prepare(
      'UPDATE users SET points_balance = points_balance + ?, last_daily_grant_date = ? WHERE id = ?'
    )
    .bind(DAILY_GRANT_AMOUNT, today, userId)
    .run();

  await db
    .prepare(
      `INSERT INTO point_ledger (user_id, change, reason) VALUES (?, ?, 'daily_grant')`
    )
    .bind(userId, DAILY_GRANT_AMOUNT)
    .run();

  return new Response(
    JSON.stringify({
      success: true,
      granted: true,
      amount: DAILY_GRANT_AMOUNT,
      balance: user.points_balance + DAILY_GRANT_AMOUNT,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
