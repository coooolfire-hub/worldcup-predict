export const EXACT_SCORE_TYPE_CODE = 'exact_score';

const COMMON_SCORE_LIMIT = 4;

const EXACT_SCORE_MULTIPLIERS = {
  draw: [8.5, 9.5, 12.0, 16.0, 22.0],
  oneGoal: [9.0, 10.0, 13.0, 17.0],
  twoGoals: [13.0, 15.0, 19.0],
  threeGoals: [19.0, 23.0],
  fourGoals: [28.0],
  other: 32.0,
};

export function exactScoreKey(homeScore, awayScore) {
  return `${homeScore}-${awayScore}`;
}

export function exactScoreOutcome(homeScore, awayScore) {
  if (homeScore >= 0 && awayScore >= 0 && homeScore <= COMMON_SCORE_LIMIT && awayScore <= COMMON_SCORE_LIMIT) {
    return exactScoreKey(homeScore, awayScore);
  }
  return 'other';
}

export function exactScoreOptions() {
  const rows = [];
  for (let home = 0; home <= COMMON_SCORE_LIMIT; home++) {
    for (let away = 0; away <= COMMON_SCORE_LIMIT; away++) {
      rows.push({
        key: exactScoreKey(home, away),
        label: `${home}:${away}`,
        multiplier: exactScoreMultiplier(home, away),
      });
    }
  }
  rows.push({ key: 'other', label: '其他比分', multiplier: EXACT_SCORE_MULTIPLIERS.other });
  return rows;
}

function exactScoreMultiplier(homeScore, awayScore) {
  const diff = Math.abs(homeScore - awayScore);
  const lowScore = Math.min(homeScore, awayScore);
  const goals = homeScore + awayScore;

  if (diff === 0) return EXACT_SCORE_MULTIPLIERS.draw[Math.min(homeScore, 4)];
  if (diff === 1) return EXACT_SCORE_MULTIPLIERS.oneGoal[Math.min(lowScore, 3)];
  if (diff === 2) return EXACT_SCORE_MULTIPLIERS.twoGoals[Math.min(lowScore, 2)];
  if (diff === 3) return EXACT_SCORE_MULTIPLIERS.threeGoals[Math.min(lowScore, 1)];
  if (diff === 4 && goals <= 4) return EXACT_SCORE_MULTIPLIERS.fourGoals[0];
  return 26.0;
}

export async function ensureCorePredictionTypes(db) {
  const types = [
    ['match_result', '比赛结果预测', '预测90分钟常规时间内的胜平负'],
    ['both_teams_score', '双方能否都进球', '预测两队是否都能进球'],
    [EXACT_SCORE_TYPE_CODE, '比分竞猜', '预测90分钟常规时间的准确比分'],
  ];

  for (const [code, name, description] of types) {
    await db
      .prepare('INSERT OR IGNORE INTO prediction_types (code, name, description) VALUES (?, ?, ?)')
      .bind(code, name, description)
      .run();
  }
}

export async function loadPredictionTypeIds(db) {
  await ensureCorePredictionTypes(db);
  const rows = await db.prepare('SELECT id, code FROM prediction_types').all();
  const map = {};
  for (const r of rows.results) map[r.code] = r.id;
  return map;
}

export async function insertExactScoreTiers(db, matchId, exactScoreTypeId) {
  for (const option of exactScoreOptions()) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO match_outcome_tiers
           (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap)
         VALUES (?, ?, ?, ?, ?, 10000)`
      )
      .bind(matchId, exactScoreTypeId, option.key, option.label, option.multiplier)
      .run();
  }
}
