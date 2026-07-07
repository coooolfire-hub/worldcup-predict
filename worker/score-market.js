// ============================================================
// 猜比分（90分钟，不含加时点球）
//   POST /api/admin/add-score-market  给指定比赛加比分玩法（16个选项，高赔率）
// 结算走 handleSettleTest 时自动判定（judge逻辑在下方 judgeScore）
// ============================================================

// 常见比分及赔率（弱队让强队时不细分，统一预设高赔）
const SCORE_OPTIONS = [
  ['s_1_0', '1:0', 9], ['s_2_0', '2:0', 12], ['s_2_1', '2:1', 11], ['s_3_0', '3:0', 20],
  ['s_3_1', '3:1', 18], ['s_3_2', '3:2', 25], ['s_0_0', '0:0', 12], ['s_1_1', '1:1', 8],
  ['s_2_2', '2:2', 18], ['s_0_1', '0:1', 10], ['s_0_2', '0:2', 14], ['s_1_2', '1:2', 12],
  ['s_0_3', '0:3', 22], ['s_1_3', '1:3', 20], ['s_2_3', '2:3', 28],
  ['s_other', '其他比分', 15],
];

// 内部复用：给比赛加比分选项（已有则跳过）
export async function addScoreTiers(db, matchId) {
  let pt = await db.prepare("SELECT id FROM prediction_types WHERE code='exact_score'").first();
  if (!pt) {
    const ins = await db.prepare("INSERT INTO prediction_types (code, name) VALUES ('exact_score', '猜比分')").run();
    pt = { id: ins.meta.last_row_id };
  }
  const exist = await db.prepare('SELECT id FROM match_outcome_tiers WHERE match_id=? AND prediction_type_id=?').bind(matchId, pt.id).first();
  if (exist) return false;
  for (const [key, label, mult] of SCORE_OPTIONS) {
    await db.prepare(`INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, ?, ?, ?, 999999)`)
      .bind(matchId, pt.id, key, label, mult).run();
  }
  return true;
}

export async function handleAddScoreMarket(request, env) {
  const { matchId } = await request.json();
  const db = env.DB;
  const match = await db.prepare('SELECT * FROM matches WHERE id=?').bind(matchId).first();
  if (!match) return jsonErr('比赛不存在', 404);
  const added = await addScoreTiers(db, matchId);
  if (!added) return jsonErr('该比赛已有比分玩法', 409);
  return jsonOk({ message: `已给比赛#${matchId}添加猜比分` });
}

// 批量给所有未开赛比赛加比分玩法
export async function handleAddScoreAll(request, env) {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const matches = await db.prepare("SELECT id FROM matches WHERE status='scheduled' AND kickoff_time > ?").bind(now).all();
  let added = 0;
  for (const m of matches.results) {
    if (await addScoreTiers(db, m.id)) added++;
  }
  return jsonOk({ message: `已给 ${added} 场未开赛比赛添加猜比分` });
}

// 结算时判定比分：返回中奖的 outcome_key
export function judgeScore(homeScore, awayScore) {
  const key = `s_${homeScore}_${awayScore}`;
  return SCORE_OPTIONS.some(o => o[0] === key) ? key : 's_other';
}

function jsonOk(b) { return new Response(JSON.stringify({ success: true, ...b }), { headers: { 'Content-Type': 'application/json' } }); }
function jsonErr(m, s) { return new Response(JSON.stringify({ success: false, error: m }), { status: s, headers: { 'Content-Type': 'application/json' } }); }
