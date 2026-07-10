import { fetchAllFixtures, fetchTeamRankings } from './sports-api.js';
import { estimateProbs, multipliersFromProbs, binaryMultipliers } from './odds.js';
import { EXACT_SCORE_TYPE_CODE, insertExactScoreTiers, loadPredictionTypeIds } from './score-markets.js';

export async function syncMatches(env) {
  const db = env.DB;
  const apiKey = env.SPORTS_API_KEY;

  const fixtures = await fetchAllFixtures(apiKey);
  const rankings = await fetchTeamRankings(apiKey);
  const summary = { total: fixtures.length, created: 0, marketsCreated: 0, skipped: 0 };
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
      if (existing.status !== fx.status) {
        await db.prepare('UPDATE matches SET status = ? WHERE id = ?').bind(fx.status, matchId).run();
      }
    }

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

async function generateMarketsForMatch(db, ptypes, match, fx, rankings) {
  const homeRank = rankings[fx.homeTeamId] ?? null;
  const awayRank = rankings[fx.awayTeamId] ?? null;

  const probs = estimateProbs(homeRank, awayRank);
  const mr = multipliersFromProbs(probs);
  const mrType = ptypes.match_result;
  const mrRows = [
    ['home_win', `${fx.homeTeam}胜`, mr.home_win],
    ['draw', '平局', mr.draw],
    ['away_win', `${fx.awayTeam}胜`, mr.away_win],
  ];
  for (const [key, label, mult] of mrRows) {
    await upsertTier(db, match.id, mrType, key, label, mult);
  }

  const closeness = homeRank != null && awayRank != null
    ? 1 - Math.min(Math.abs(homeRank - awayRank) / 30, 0.5)
    : 0.8;
  const bts = binaryMultipliers(0.45 + 0.15 * closeness);
  const btsType = ptypes.both_teams_score;
  await upsertTier(db, match.id, btsType, 'yes', '双方都进球', bts.yes);
  await upsertTier(db, match.id, btsType, 'no', '双方0进球', bts.no);

  await insertExactScoreTiers(db, match.id, ptypes[EXACT_SCORE_TYPE_CODE]);

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
       VALUES (?, ?, ?, ?, ?, 10000)
       ON CONFLICT(match_id, prediction_type_id, outcome_key)
       DO UPDATE SET multiplier = excluded.multiplier, outcome_label = excluded.outcome_label`
    )
    .bind(matchId, ptypeId, key, label, mult)
    .run();
}
