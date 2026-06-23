// ============================================================
// 管理员接口：创建比赛 + 设置赔率档
// 这俩接口需要做权限校验（比如检查一个admin token），示例里先省略，
// 上线前必须加，不然任何人都能改赔率。
//
// 关键合规点都在这里强制：
//   - 赔率一旦锁定（match.tiers_locked_at 有值），就不能再改，
//     对应"赔率开赛前定好、不跟着资金量实时浮动"这条设计原则
//   - stake_cap 在这里设置，每场比赛可以给不同结果设不同上限，
//     方便后续按监管反馈调整数值而不用动代码
// ============================================================

export async function handleCreateMatch(request, env) {
  const db = env.DB;
  const { externalMatchId, stage, homeTeam, awayTeam, kickoffTime } = await request.json();

  const result = await db
    .prepare(
      `INSERT INTO matches (external_match_id, stage, home_team, away_team, kickoff_time)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(externalMatchId, stage, homeTeam, awayTeam, kickoffTime)
    .run();

  return jsonOk({ matchId: result.meta.last_row_id });
}

export async function handleSetTiers(request, env) {
  const db = env.DB;
  const { matchId, tiers } = await request.json();
  // tiers: [{ predictionTypeCode, outcomeKey, outcomeLabel, multiplier, stakeCap }]

  const match = await db.prepare('SELECT * FROM matches WHERE id = ?').bind(matchId).first();
  if (!match) return jsonError('比赛不存在', 404);

  if (match.tiers_locked_at) {
    return jsonError('该比赛的赔率已锁定，无法修改（比赛开赛前才能设置/调整赔率）', 400);
  }

  const now = Math.floor(Date.now() / 1000);
  if (now >= match.kickoff_time) {
    return jsonError('比赛已开赛，不能再设置赔率', 400);
  }

  for (const tier of tiers) {
    const ptype = await db
      .prepare('SELECT id FROM prediction_types WHERE code = ?')
      .bind(tier.predictionTypeCode)
      .first();
    if (!ptype) continue;

    await db
      .prepare(
        `INSERT INTO match_outcome_tiers
           (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_id, prediction_type_id, outcome_key)
         DO UPDATE SET multiplier = excluded.multiplier, stake_cap = excluded.stake_cap`
      )
      .bind(
        matchId,
        ptype.id,
        tier.outcomeKey,
        tier.outcomeLabel,
        tier.multiplier,
        tier.stakeCap || 10000
      )
      .run();
  }

  return jsonOk({ message: '赔率档已设置，调用 /api/admin/lock-tiers 锁定后用户才能下注' });
}

// 显式锁定动作，跟"设置"分开两步，避免设完顺手就开放下注、忘了再检查一遍
export async function handleLockTiers(request, env) {
  const db = env.DB;
  const { matchId } = await request.json();

  await db
    .prepare('UPDATE matches SET tiers_locked_at = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000), matchId)
    .run();

  return jsonOk({ message: '赔率已锁定，比赛开赛前用户均可以此赔率下注' });
}

function jsonOk(body) {
  return new Response(JSON.stringify({ success: true, ...body }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
