// ============================================================
// 结算 worker（cron 定期调用，频率可低）
//
// 两类结算：
//   A. 单场比赛结算：比赛完场 -> 判定 match_result / both_teams_score
//   B. 赛事级结算：整届结束 -> 判定 champion / top_scorer
//
// 积分模型（按需求确认）：下注即扣，猜对按倍率发奖励，猜错不返还。
//   结算时只给"猜对的人"发 payout，猜错的不动（下注时已扣）。
//   赢家 payout 是平台新发放积分，不是从输家转移（合规：非零和）。
// ============================================================

import { fetchSingleMatch, fetchTournamentResult, fetchTopScorers } from './sports-api.js';
import { judgeMatchOutcome } from './judge.js';

export async function runSettlement(env) {
  const summary = { matchesChecked: 0, matchesSettled: 0, tournamentSettled: false, errors: [] };
  await settleMatches(env, summary);
  await settleTournament(env, summary);
  return summary;
}

async function settleMatches(env, summary) {
  const db = env.DB;
  const apiKey = env.SPORTS_API_KEY;
  const pending = await db
    .prepare(`SELECT * FROM matches WHERE status IN ('scheduled','live') AND kickoff_time <= ?`)
    .bind(Math.floor(Date.now() / 1000))
    .all();

  for (const match of pending.results) {
    summary.matchesChecked += 1;
    try {
      const latest = await fetchSingleMatch(apiKey, match.external_match_id);
      if (!latest) continue;
      if (latest.status === 'cancelled') { await voidMatch(db, match.id); continue; }
      if (latest.status === 'live' && match.status !== 'live') {
        await db.prepare('UPDATE matches SET status=? WHERE id=?').bind('live', match.id).run();
        continue;
      }
      if (latest.status !== 'finished') continue;
      await settleOneMatch(db, match, latest);
      summary.matchesSettled += 1;
    } catch (err) {
      summary.errors.push({ matchId: match.id, error: String(err) });
    }
  }
}

async function settleOneMatch(db, match, finalResult) {
  const { homeScore, awayScore } = finalResult;
  await db.prepare(`UPDATE matches SET status='finished', home_score=?, away_score=? WHERE id=?`)
    .bind(homeScore, awayScore, match.id).run();

  const typeRows = await db.prepare(
    `SELECT DISTINCT pt.id, pt.code FROM match_outcome_tiers t
     JOIN prediction_types pt ON pt.id = t.prediction_type_id WHERE t.match_id=?`
  ).bind(match.id).all();

  const actualByType = {};
  for (const row of typeRows.results) {
    if (row.code === 'match_result' || row.code === 'both_teams_score') {
      actualByType[row.id] = judgeMatchOutcome(row.code, homeScore, awayScore);
    }
  }
  await payoutPredictions(db, match.id, actualByType);
  await db.prepare('UPDATE matches SET settled_at=? WHERE id=?')
    .bind(Math.floor(Date.now() / 1000), match.id).run();
}

async function settleTournament(env, summary) {
  const db = env.DB;
  const apiKey = env.SPORTS_API_KEY;
  let openMarkets;
  try {
    openMarkets = await db.prepare(
      `SELECT id AS market_id, market_code FROM event_markets WHERE status='open'`
    ).all();
  } catch (e) { return; } // event_markets 表不存在则跳过
  if (!openMarkets.results || openMarkets.results.length === 0) return;

  let championResult = null, topScorerResult = null;
  for (const market of openMarkets.results) {
    try {
      if (market.market_code === 'champion') {
        if (!championResult) championResult = await fetchTournamentResult(apiKey);
        if (!championResult.finished) continue;
        await settleEventMarket(db, market.market_id, championResult.championTeamId);
        summary.tournamentSettled = true;
      } else if (market.market_code === 'top_scorer') {
        if (!championResult) championResult = await fetchTournamentResult(apiKey);
        if (!championResult.finished) continue;
        if (!topScorerResult) {
          try {
            const scorers = await fetchTopScorers(apiKey);
            topScorerResult = scorers.length ? scorers[0].playerId : null;
          } catch (e) {
            summary.errors.push({ market: 'top_scorer', error: '射手榜接口不可用，跳过' });
            continue;
          }
        }
        if (!topScorerResult) continue;
        await settleEventMarket(db, market.market_id, topScorerResult);
        summary.tournamentSettled = true;
      }
    } catch (err) {
      summary.errors.push({ marketId: market.market_id, error: String(err) });
    }
  }
}

async function settleEventMarket(db, marketId, winnerKey) {
  const market = await db.prepare('SELECT * FROM event_markets WHERE id=?').bind(marketId).first();
  if (!market || market.status !== 'open') return;
  const preds = await db.prepare(
    `SELECT * FROM event_predictions WHERE market_id=? AND status='pending'`
  ).bind(marketId).all();

  for (const pred of preds.results) {
    const won = pred.outcome_key === winnerKey;
    const payout = won ? Math.round(pred.points_staked * pred.multiplier_locked) : 0;
    await db.prepare(`UPDATE event_predictions SET status=?, points_awarded=?, settled_at=? WHERE id=?`)
      .bind(won ? 'won' : 'lost', payout, Math.floor(Date.now() / 1000), pred.id).run();
    if (won && payout > 0) await creditUser(db, pred.user_id, payout, 'event_payout', 'event_predictions', pred.id);
    await updateStreak(db, pred.user_id, won);
  }
  await db.prepare(`UPDATE event_markets SET status='settled', settled_at=?, winner_key=? WHERE id=?`)
    .bind(Math.floor(Date.now() / 1000), winnerKey, marketId).run();
}

async function payoutPredictions(db, matchId, actualByType) {
  const pending = await db.prepare(`SELECT * FROM predictions WHERE match_id=? AND status='pending'`)
    .bind(matchId).all();
  for (const pred of pending.results) {
    const actual = actualByType[pred.prediction_type_id];
    if (actual === undefined) continue;
    const won = actual === pred.outcome_key;
    const payout = won ? Math.round(pred.points_staked * pred.multiplier_locked) : 0;
    await db.prepare(`UPDATE predictions SET status=?, points_awarded=?, settled_at=? WHERE id=?`)
      .bind(won ? 'won' : 'lost', payout, Math.floor(Date.now() / 1000), pred.id).run();
    if (won && payout > 0) await creditUser(db, pred.user_id, payout, 'payout', 'predictions', pred.id);
    await updateStreak(db, pred.user_id, won);
  }
}

async function creditUser(db, userId, amount, reason, refTable, refId) {
  await db.prepare(`INSERT INTO point_ledger (user_id, change, reason, ref_table, ref_id) VALUES (?,?,?,?,?)`)
    .bind(userId, amount, reason, refTable, refId).run();
  await db.prepare('UPDATE users SET points_balance = points_balance + ? WHERE id=?')
    .bind(amount, userId).run();
}

async function voidMatch(db, matchId) {
  const pending = await db.prepare(`SELECT * FROM predictions WHERE match_id=? AND status='pending'`)
    .bind(matchId).all();
  for (const pred of pending.results) {
    await db.prepare(`UPDATE predictions SET status='void', settled_at=? WHERE id=?`)
      .bind(Math.floor(Date.now() / 1000), pred.id).run();
    await creditUser(db, pred.user_id, pred.points_staked, 'refund', 'predictions', pred.id);
  }
  await db.prepare(`UPDATE matches SET status='cancelled' WHERE id=?`).bind(matchId).run();
}

async function updateStreak(db, userId, won) {
  let streak = await db.prepare('SELECT * FROM user_streaks WHERE user_id=?').bind(userId).first();
  if (!streak) {
    await db.prepare('INSERT INTO user_streaks (user_id, current_streak, best_streak) VALUES (?,0,0)')
      .bind(userId).run();
    streak = { current_streak: 0, best_streak: 0 };
  }
  const cur = won ? streak.current_streak + 1 : 0;
  const best = Math.max(cur, streak.best_streak);
  await db.prepare('UPDATE user_streaks SET current_streak=?, best_streak=?, updated_at=? WHERE user_id=?')
    .bind(cur, best, Math.floor(Date.now() / 1000), userId).run();
  const milestones = { 5: 'streak_5', 10: 'streak_10', 20: 'streak_20' };
  if (won && milestones[cur]) await unlockAchievement(db, userId, milestones[cur]);
}

async function unlockAchievement(db, userId, code) {
  const a = await db.prepare('SELECT id FROM achievements WHERE code=?').bind(code).first();
  if (!a) return;
  await db.prepare('INSERT OR IGNORE INTO user_achievements (user_id, achievement_id) VALUES (?,?)')
    .bind(userId, a.id).run();
}
