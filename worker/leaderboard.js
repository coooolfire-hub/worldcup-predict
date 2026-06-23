// ============================================================
// 排行榜接口
// GET /api/leaderboard?type=points|streak&limit=50
//
// 两种榜：
//   - points: 当前积分余额榜（注意这是"手里有多少"，不是"赢了多少"，
//     爱冒险全押的人余额未必高，这个区分对用户心理感受很重要）
//   - streak: 当前连续命中榜，对应产品里最想强化的"猜得准"荣誉感
// ============================================================

export async function handleLeaderboard(request, env) {
  const db = env.DB;
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'points';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

  if (type === 'streak') {
    const rows = await db
      .prepare(
        `SELECT u.id, u.nickname, s.current_streak, s.best_streak
         FROM user_streaks s
         JOIN users u ON u.id = s.user_id
         ORDER BY s.current_streak DESC, s.best_streak DESC
         LIMIT ?`
      )
      .bind(limit)
      .all();

    return jsonOk({ type: 'streak', rows: rows.results });
  }

  const rows = await db
    .prepare(
      `SELECT id, nickname, points_balance
       FROM users
       ORDER BY points_balance DESC
       LIMIT ?`
    )
    .bind(limit)
    .all();

  return jsonOk({ type: 'points', rows: rows.results });
}

function jsonOk(body) {
  return new Response(JSON.stringify({ success: true, ...body }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
