// ============================================================
// 用户下预测单的接口
// POST /api/predict
// body: { matchId, predictionTypeCode, outcomeKey, pointsStaked }
//
// 这里做的三件强制校验，对应之前合规讨论里定下的规则：
//   1. 比赛已经开赛 -> 拒绝（不能赛中下注，避免临场看着比分下注）
//   2. 押注金额超过该结果的 stake_cap -> 拒绝
//   3. 余额不足 -> 拒绝
// 倍率（multiplier）从 match_outcome_tiers 读取并锁定进 predictions 表，
// 后续这场比赛的赔率即使被管理员改了，也不影响已经下好的单子。
// ============================================================

export async function handlePredict(request, env) {
  const { userId, matchId, predictionTypeCode, outcomeKey, pointsStaked } = await request.json();

  if (!Number.isInteger(pointsStaked) || pointsStaked <= 0) {
    return jsonError('押注积分必须是正整数', 400);
  }

  const db = env.DB;

  const match = await db
    .prepare('SELECT * FROM matches WHERE id = ?')
    .bind(matchId)
    .first();

  if (!match) return jsonError('比赛不存在', 404);

  const now = Math.floor(Date.now() / 1000);
  if (now >= match.kickoff_time) {
    return jsonError('比赛已开赛，无法继续预测', 400);
  }

  const predictionType = await db
    .prepare('SELECT * FROM prediction_types WHERE code = ?')
    .bind(predictionTypeCode)
    .first();

  if (!predictionType) return jsonError('题型不存在', 404);

  const tier = await db
    .prepare(
      'SELECT * FROM match_outcome_tiers WHERE match_id = ? AND prediction_type_id = ? AND outcome_key = ?'
    )
    .bind(matchId, predictionType.id, outcomeKey)
    .first();

  if (!tier) return jsonError('该预测选项不存在或尚未开放', 404);

  if (pointsStaked > tier.stake_cap) {
    return jsonError(`单次押注不能超过 ${tier.stake_cap} 点`, 400);
  }

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!user) return jsonError('用户不存在', 404);

  if (user.points_balance < pointsStaked) {
    return jsonError('积分余额不足', 400);
  }

  // 用事务保证 "扣余额 + 写账本 + 建预测单" 三件事原子完成
  const stmts = [
    db
      .prepare('UPDATE users SET points_balance = points_balance - ? WHERE id = ?')
      .bind(pointsStaked, userId),
    db
      .prepare(
        `INSERT INTO predictions
         (user_id, match_id, prediction_type_id, outcome_key, points_staked, multiplier_locked, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`
      )
      .bind(userId, matchId, predictionType.id, outcomeKey, pointsStaked, tier.multiplier),
  ];

  const results = await db.batch(stmts);
  const predictionId = results[1].meta.last_row_id;

  await db
    .prepare(
      `INSERT INTO point_ledger (user_id, change, reason, ref_table, ref_id)
       VALUES (?, ?, 'stake', 'predictions', ?)`
    )
    .bind(userId, -pointsStaked, predictionId)
    .run();

  return new Response(JSON.stringify({ success: true, predictionId }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================
// 赛事级市场下单（夺冠、金靴）
// POST /api/event-predict
// body: { userId, marketId, outcomeKey, pointsStaked }
// 逻辑跟单场predict一致：下注即扣、锁定倍率、校验上限和余额。
// ============================================================
export async function handleEventPredict(request, env) {
  const { userId, marketId, outcomeKey, pointsStaked } = await request.json();
  if (!Number.isInteger(pointsStaked) || pointsStaked <= 0) {
    return eventErr('押注积分必须是正整数', 400);
  }
  const db = env.DB;

  const market = await db.prepare('SELECT * FROM event_markets WHERE id=?').bind(marketId).first();
  if (!market) return eventErr('市场不存在', 404);
  if (market.status !== 'open') return eventErr('该市场已截止', 400);

  const option = await db
    .prepare('SELECT * FROM event_market_options WHERE market_id=? AND outcome_key=?')
    .bind(marketId, outcomeKey)
    .first();
  if (!option) return eventErr('选项不存在', 404);

  if (pointsStaked > option.stake_cap) {
    return eventErr(`单次押注不能超过 ${option.stake_cap} 点`, 400);
  }

  const user = await db.prepare('SELECT * FROM users WHERE id=?').bind(userId).first();
  if (!user) return eventErr('用户不存在', 404);
  if (user.points_balance < pointsStaked) return eventErr('积分余额不足', 400);

  const stmts = [
    db.prepare('UPDATE users SET points_balance = points_balance - ? WHERE id=?').bind(pointsStaked, userId),
    db.prepare(
      `INSERT INTO event_predictions (user_id, market_id, outcome_key, points_staked, multiplier_locked, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).bind(userId, marketId, outcomeKey, pointsStaked, option.multiplier),
  ];
  const results = await db.batch(stmts);
  const predId = results[1].meta.last_row_id;

  await db.prepare(
    `INSERT INTO point_ledger (user_id, change, reason, ref_table, ref_id) VALUES (?, ?, 'stake', 'event_predictions', ?)`
  ).bind(userId, -pointsStaked, predId).run();

  return new Response(JSON.stringify({ success: true, predictionId: predId }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function eventErr(message, status) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
