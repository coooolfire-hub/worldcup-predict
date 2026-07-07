// ============================================================
// 排行榜接口
// GET /api/leaderboard?type=points|wins&limit=50
//
// 两种榜：
//   - points: 当前积分余额榜（手里有多少积分）
//   - wins:   胜利榜，按累计猜中场次（predictions 里 status='won' 的数量）排名
// ============================================================

export async function handleLeaderboard(request, env) {
  const db = env.DB;
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'score';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

  if (type === 'score') {
    // 得分榜：累计赢得的积分总和（押中的所有 payout，含单场和赛事）
    const rows = await db
      .prepare(
        `SELECT u.id, u.nickname,
                COALESCE(SUM(l.change), 0) AS total_won,
                u.points_balance
         FROM users u
         JOIN point_ledger l ON l.user_id = u.id AND l.reason IN ('payout','event_payout')
         GROUP BY u.id
         ORDER BY total_won DESC, u.points_balance DESC
         LIMIT ?`
      )
      .bind(limit)
      .all();
    return jsonOk({ type: 'score', rows: rows.results });
  }

  if (type === 'wins') {
    // 胜利榜：累计猜中场次（单场 + 赛事）
    const rows = await db
      .prepare(
        `SELECT u.id, u.nickname, u.points_balance,
                (SELECT COUNT(*) FROM predictions p WHERE p.user_id=u.id AND p.status='won')
              + (SELECT COUNT(*) FROM event_predictions e WHERE e.user_id=u.id AND e.status='won') AS win_count
         FROM users u
         WHERE win_count > 0
         ORDER BY win_count DESC, u.points_balance DESC
         LIMIT ?`
      )
      .bind(limit)
      .all();
    return jsonOk({ type: 'wins', rows: rows.results });
  }

  // 积分榜：当前余额
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
