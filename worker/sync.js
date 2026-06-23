// ============================================================
// 比赛自动同步 + 赔率自动生成
// 由管理员触发或 cron 定期调用（频率低，比如每天几次）
//
// 流程：
//   1. 从 api-sports 拉所有世界杯比赛
//   2. 新比赛 -> 插入 matches 表
//   3. 对未开赛、还没设赔率的比赛，用算法生成胜平负 + 双方进球市场，锁定
//   4. 已存在的比赛只更新状态（不动已锁定的赔率）
// ============================================================

import { fetchAllFixtures, fetchTeamRankings } from './sports-api.js';
import { estimateProbs, multipliersFromProbs, binaryMultipliers } from './odds.js';

export async function syncMatches(env) {
  const db = env.DB;
  const apiKey = env.SPORTS_API_KEY;

  const fixtures = await fetchAllFixtures(apiKey);
  const rankings = await fetchTeamRankings(apiKey); // 拿不到会是 {}

  const summary = { total: fixtures.length, created: 0, marketsCreated: 0, skipped: 0 };

  // 题型id缓存
  const ptypes = await loadPredictionTypeIds(db);

  for (const fx of fixtures) {
    const existing = await db
      .prepare('SELECT * FROM matches WHERE external_match_id = ?')
      .bind(fx.externalMatchId)
      .first();

    let matchId;
    if (!existing) {
      const ins = await db
        .prepare(
          `INSERT INTO matches (external_match_id, stage, home_team, away_team, kickoff_time, status)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(fx.externalMatchId, fx.stage, fx.homeTeam, fx.awayTeam, fx.kickoffTime, fx.status)
        .run();
      matchId = ins.meta.last_row_id;
      summary.created += 1;
    } else {
      matchId = existing.id;
      // 已存在：只在状态变化时更新状态，绝不动已锁定的赔率
      if (existing.status !== fx.status) {
        await db.prepare('UPDATE matches SET status = ? WHERE id = ?').bind(fx.status, matchId).run();
      }
    }

    // 只给"未开赛 + 还没锁定赔率"的比赛生成市场
    const match = await db.prepare('SELECT * FROM matches WHERE id = ?').bind(matchId).first();
    const now = Math.floor(Date.now() / 1000);
    if (match.status === 'scheduled' && !match.tiers_locked_at && match.kickoff_time > now) {
      await generateMarketsForMatch(db, ptypes, match, fx, rankings);
      summary.marketsCreated += 1;
    } else {
      summary.skipped += 1;
    }
  }

  return summary;
}

// 给一场比赛生成胜平负 + 双方进球市场，并锁定赔率
async function generateMarketsForMatch(db, ptypes, match, fx, rankings) {
  const homeRank = rankings[fx.homeTeamId] ?? null;
  const awayRank = rankings[fx.awayTeamId] ?? null;

  // --- 胜平负市场 ---
  const probs = estimateProbs(homeRank, awayRank);
  const mr = multipliersFromProbs(probs);
  const mrType = ptypes['match_result'];
  const mrRows = [
    ['home_win', `${fx.homeTeam}胜`, mr.home_win],
    ['draw', '平局', mr.draw],
    ['away_win', `${fx.awayTeam}胜`, mr.away_win],
  ];
  for (const [key, label, mult] of mrRows) {
    await upsertTier(db, match.id, mrType, key, label, mult);
  }

  // --- 双方是否都进球市场 ---
  // "是"的基础概率经验值约0.55，强弱悬殊时略降
  const closeness = homeRank != null && awayRank != null
    ? 1 - Math.min(Math.abs(homeRank - awayRank) / 30, 0.5)
    : 0.8;
  const btsYes = 0.45 + 0.15 * closeness; // 两队越接近，越可能互相进球
  const bts = binaryMultipliers(btsYes);
  const btsType = ptypes['both_teams_score'];
  await upsertTier(db, match.id, btsType, 'yes', '双方都进球', bts.yes);
  await upsertTier(db, match.id, btsType, 'no', '非双方都进', bts.no);

  // 锁定赔率
  await db
    .prepare('UPDATE matches SET tiers_locked_at = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000), match.id)
    .run();
}

async function upsertTier(db, matchId, ptypeId, key, label, mult) {
  await db
    .prepare(
      `INSERT INTO match_outcome_tiers
         (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id, prediction_type_id, outcome_key)
       DO UPDATE SET multiplier = excluded.multiplier, outcome_label = excluded.outcome_label`
    )
    .bind(matchId, ptypeId, key, label, mult, 10000) // stake_cap 默认10000，对应之前的决定
    .run();
}

async function loadPredictionTypeIds(db) {
  const rows = await db.prepare('SELECT id, code FROM prediction_types').all();
  const map = {};
  for (const r of rows.results) map[r.code] = r.id;
  return map;
}
