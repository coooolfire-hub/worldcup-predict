import { EXACT_SCORE_TYPE_CODE, insertExactScoreTiers, loadPredictionTypeIds } from './score-markets.js';

export async function handleBackfillExactScoreMarkets(request, env) {
  const db = env.DB;
  const ptypes = await loadPredictionTypeIds(db);
  const exactScoreTypeId = ptypes[EXACT_SCORE_TYPE_CODE];
  const now = Math.floor(Date.now() / 1000);

  const matches = await db
    .prepare(
      `SELECT id FROM matches
       WHERE status = 'scheduled'
         AND kickoff_time > ?`
    )
    .bind(now)
    .all();

  let matchesChecked = 0;
  let optionsAdded = 0;
  for (const match of matches.results) {
    matchesChecked += 1;
    const before = await countExactScoreOptions(db, match.id, exactScoreTypeId);
    await insertExactScoreTiers(db, match.id, exactScoreTypeId);
    const after = await countExactScoreOptions(db, match.id, exactScoreTypeId);
    optionsAdded += Math.max(0, after - before);
  }

  return new Response(JSON.stringify({ success: true, matchesChecked, optionsAdded }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function countExactScoreOptions(db, matchId, exactScoreTypeId) {
  const row = await db
    .prepare('SELECT COUNT(*) AS c FROM match_outcome_tiers WHERE match_id=? AND prediction_type_id=?')
    .bind(matchId, exactScoreTypeId)
    .first();
  return row?.c || 0;
}

// ============================================================
// 修正已结算比赛的错误比分
//
// 场景：管理员在后台"录入结果"时手滑填错了比分，点了结算，
// 现在后台显示"已结算 X:Y"，但 X:Y 是错的。
// handleSettleTest 结算后会锁死（status='finished' 就拒绝再次结算），
// 所以需要一个专门的"改比分"入口：
//   1. 撤销这场比赛所有已发的 payout（追回积分，写反向 point_ledger 记录）
//   2. 把预测状态退回 pending
//   3. 写入正确比分
//   4. 按正确比分重新走一遍结算逻辑（和 handleSettleTest 的判定规则保持一致）
// ============================================================
export async function handleCorrectMatchScore(request, env) {
  const { matchId, homeScore, awayScore } = await request.json();
  const db = env.DB;

  if (matchId == null || homeScore == null || awayScore == null) {
    return jsonError('缺少参数：matchId / homeScore / awayScore', 400);
  }

  const match = await db.prepare('SELECT * FROM matches WHERE id=?').bind(matchId).first();
  if (!match) return jsonError('比赛不存在', 404);
  if (match.status !== 'finished' && match.status !== 'settled') {
    return jsonError('这场比赛还没结算，直接在比分框里改成正确比分、点结算即可，不用走这个接口', 400);
  }
  if (match.home_score === homeScore && match.away_score === awayScore) {
    return jsonError('新比分和原比分一样，无需修改', 400);
  }

  const oldHome = match.home_score;
  const oldAway = match.away_score;

  // 1) 撤销旧结算：把已发的积分追回，预测状态退回 pending
  const settledPreds = await db
    .prepare(`SELECT * FROM predictions WHERE match_id=? AND status IN ('won','lost')`)
    .bind(matchId)
    .all();

  let reversedCount = 0;
  let reversedPoints = 0;
  for (const pred of settledPreds.results) {
    if (pred.points_awarded > 0) {
      await db
        .prepare(
          `INSERT INTO point_ledger (user_id, change, reason, ref_table, ref_id) VALUES (?, ?, 'payout', 'predictions', ?)`
        )
        .bind(pred.user_id, -pred.points_awarded, pred.id)
        .run();
      await db
        .prepare('UPDATE users SET points_balance = points_balance - ? WHERE id=?')
        .bind(pred.points_awarded, pred.user_id)
        .run();
      reversedPoints += pred.points_awarded;
    }
    await db
      .prepare(`UPDATE predictions SET status='pending', points_awarded=0, settled_at=NULL WHERE id=?`)
      .bind(pred.id)
      .run();
    reversedCount++;
  }

  // 2) 写入正确比分
  await db
    .prepare(`UPDATE matches SET home_score=?, away_score=?, status='finished' WHERE id=?`)
    .bind(homeScore, awayScore, matchId)
    .run();

  // 3) 按正确比分重新结算（判定规则和 handleSettleTest 保持一致，避免同一场比赛前后用不同规则判输赢）
  const typeRows = await db
    .prepare(
      `SELECT DISTINCT pt.id, pt.code FROM match_outcome_tiers t JOIN prediction_types pt ON pt.id=t.prediction_type_id WHERE t.match_id=?`
    )
    .bind(matchId)
    .all();
  const actualByType = {};
  for (const row of typeRows.results) {
    if (row.code === 'match_result') {
      actualByType[row.id] = homeScore > awayScore ? 'home_win' : homeScore < awayScore ? 'away_win' : 'draw';
    } else if (row.code === 'both_teams_score') {
      if (homeScore > 0 && awayScore > 0) actualByType[row.id] = 'yes';
      else if (homeScore === 0 && awayScore === 0) actualByType[row.id] = 'no';
      else actualByType[row.id] = 'none';
    } else if (row.code === 'exact_score') {
      const key = `s_${homeScore}_${awayScore}`;
      actualByType[row.id] = key;
      actualByType[row.id + '_fallback'] = 's_other';
    }
  }

  const pending = await db.prepare(`SELECT * FROM predictions WHERE match_id=? AND status='pending'`).bind(matchId).all();
  let settledCount = 0;
  let newPayoutTotal = 0;
  for (const pred of pending.results) {
    const actual = actualByType[pred.prediction_type_id];
    if (actual === undefined) continue;
    let won = actual === pred.outcome_key;
    if (!won && pred.outcome_key === 's_other') {
      const tierExists = await db
        .prepare('SELECT id FROM match_outcome_tiers WHERE match_id=? AND prediction_type_id=? AND outcome_key=?')
        .bind(matchId, pred.prediction_type_id, actual)
        .first();
      if (!tierExists) won = true;
    }
    const payout = won ? Math.round(pred.points_staked * pred.multiplier_locked) : 0;
    await db
      .prepare(`UPDATE predictions SET status=?, points_awarded=?, settled_at=? WHERE id=?`)
      .bind(won ? 'won' : 'lost', payout, Math.floor(Date.now() / 1000), pred.id)
      .run();
    if (won && payout > 0) {
      await db
        .prepare(`INSERT INTO point_ledger (user_id, change, reason, ref_table, ref_id) VALUES (?, ?, 'payout', 'predictions', ?)`)
        .bind(pred.user_id, payout, pred.id)
        .run();
      await db.prepare('UPDATE users SET points_balance = points_balance + ? WHERE id=?').bind(payout, pred.user_id).run();
      newPayoutTotal += payout;
    }
    settledCount++;
  }
  await db.prepare('UPDATE matches SET settled_at=? WHERE id=?').bind(Math.floor(Date.now() / 1000), matchId).run();

  return jsonOk({
    message: `比分已从 ${oldHome}:${oldAway} 改为 ${homeScore}:${awayScore}，撤销旧结算 ${reversedCount} 条（追回 ${reversedPoints} 积分），重新结算 ${settledCount} 条（发放 ${newPayoutTotal} 积分）`,
  });
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
