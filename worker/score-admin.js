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
