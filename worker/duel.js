// ============================================================
// 1v1 对赌
//   POST /api/duel-create   发起（选比赛+押方向+押多少）冻结积分
//   POST /api/duel-accept   接单（对方持相反方向）冻结积分
//   POST /api/duel-cancel   发起人取消（未被接时）退积分
//   GET  /api/duels         列出对赌（开放中/已成局）
// 结算：比赛结算时（settle-duels在handleSettleTest后调用或单独接口）
//   POST /api/admin/settle-duels  按比赛结果结算该比赛所有对赌
// 规则：发起人押"某队胜"，接单人自动持"对方不胜"（含平局和对方赢）。
//       90分钟比分判定。赢家拿走双方全部积分。
// ============================================================

export async function handleDuelCreate(request, env) {
  const { userId, matchId, outcomeKey, points } = await request.json();
  const db = env.DB;
  ensureTableSafe(db);
  if (!userId || !matchId || !['home_win','draw','away_win'].includes(outcomeKey)) return jErr('参数错误', 400);
  if (!Number.isInteger(points) || points < 100) return jErr('至少100点', 400);

  const match = await db.prepare('SELECT * FROM matches WHERE id=?').bind(matchId).first();
  if (!match) return jErr('比赛不存在', 404);
  if (Math.floor(Date.now()/1000) >= match.kickoff_time) return jErr('比赛已开赛', 400);

  const user = await db.prepare('SELECT points_balance FROM users WHERE id=?').bind(userId).first();
  if (!user || user.points_balance < points) return jErr('余额不足', 400);

  await db.prepare('UPDATE users SET points_balance=points_balance-? WHERE id=?').bind(points, userId).run();
  await db.prepare(`INSERT INTO point_ledger (user_id, change, reason) VALUES (?, ?, 'duel_stake')`).bind(userId, -points).run();
  const ins = await db.prepare(`INSERT INTO duels (match_id, creator_id, creator_outcome, points) VALUES (?, ?, ?, ?)`).bind(matchId, userId, outcomeKey, points).run();
  return jOk({ message: '对赌已发起，等人应战', duelId: ins.meta.last_row_id });
}

export async function handleDuelAccept(request, env) {
  const { userId, duelId } = await request.json();
  const db = env.DB;
  ensureTableSafe(db);
  const duel = await db.prepare("SELECT * FROM duels WHERE id=? AND status='open'").bind(duelId).first();
  if (!duel) return jErr('对赌不存在或已被接', 404);
  if (duel.creator_id === userId) return jErr('不能接自己的对赌', 400);

  const match = await db.prepare('SELECT * FROM matches WHERE id=?').bind(duel.match_id).first();
  if (Math.floor(Date.now()/1000) >= match.kickoff_time) return jErr('比赛已开赛', 400);

  const user = await db.prepare('SELECT points_balance FROM users WHERE id=?').bind(userId).first();
  if (!user || user.points_balance < duel.points) return jErr('余额不足', 400);

  await db.prepare('UPDATE users SET points_balance=points_balance-? WHERE id=?').bind(duel.points, userId).run();
  await db.prepare(`INSERT INTO point_ledger (user_id, change, reason) VALUES (?, ?, 'duel_stake')`).bind(userId, -duel.points).run();
  await db.prepare("UPDATE duels SET opponent_id=?, status='matched' WHERE id=?").bind(userId, duelId).run();
  return jOk({ message: '应战成功！等比赛结果' });
}

export async function handleDuelCancel(request, env) {
  const { userId, duelId } = await request.json();
  const db = env.DB;
  ensureTableSafe(db);
  const duel = await db.prepare("SELECT * FROM duels WHERE id=? AND status='open' AND creator_id=?").bind(duelId, userId).first();
  if (!duel) return jErr('无法取消（不存在/已被接/不是你的）', 404);
  await db.prepare('UPDATE users SET points_balance=points_balance+? WHERE id=?').bind(duel.points, userId).run();
  await db.prepare(`INSERT INTO point_ledger (user_id, change, reason) VALUES (?, ?, 'duel_refund')`).bind(userId, duel.points).run();
  await db.prepare("UPDATE duels SET status='cancelled' WHERE id=?").bind(duelId).run();
  return jOk({ message: '已取消，积分已退回' });
}

export async function handleDuelList(request, env) {
  const db = env.DB;
  ensureTableSafe(db);
  const rows = await db.prepare(
    `SELECT d.*, m.home_team, m.away_team, m.kickoff_time,
            cu.nickname AS creator_name, ou.nickname AS opponent_name
     FROM duels d JOIN matches m ON m.id=d.match_id
     LEFT JOIN users cu ON cu.id=d.creator_id
     LEFT JOIN users ou ON ou.id=d.opponent_id
     WHERE d.status IN ('open','matched') ORDER BY d.id DESC LIMIT 50`
  ).all();
  const out = rows.results.map(d => ({
    id: d.id, matchId: d.match_id,
    home: (d.home_team||'').split('|')[0], away: (d.away_team||'').split('|')[0],
    kickoffTime: d.kickoff_time,
    creatorName: d.creator_name||'匿名', opponentName: d.opponent_name,
    outcome: d.creator_outcome, points: d.points, status: d.status,
    creatorId: d.creator_id,
  }));
  return jOk({ duels: out });
}

// 结算某比赛的所有对赌（比赛结算后调用；发起人方向命中=发起人赢，否则接单人赢）
export async function handleSettleDuels(request, env) {
  const { matchId } = await request.json();
  const db = env.DB;
  ensureTableSafe(db);
  const match = await db.prepare('SELECT * FROM matches WHERE id=? AND home_score IS NOT NULL').bind(matchId).first();
  if (!match) return jErr('比赛未结算', 400);
  const actual = match.home_score > match.away_score ? 'home_win' : match.home_score < match.away_score ? 'away_win' : 'draw';

  const duels = await db.prepare("SELECT * FROM duels WHERE match_id=? AND status IN ('open','matched')").bind(matchId).all();
  let settled = 0, refunded = 0;
  for (const d of duels.results) {
    if (d.status === 'open') {
      // 没人接，退回发起人
      await db.prepare('UPDATE users SET points_balance=points_balance+? WHERE id=?').bind(d.points, d.creator_id).run();
      await db.prepare(`INSERT INTO point_ledger (user_id, change, reason) VALUES (?, ?, 'duel_refund')`).bind(d.creator_id, d.points).run();
      await db.prepare("UPDATE duels SET status='cancelled' WHERE id=?").bind(d.id).run();
      refunded++;
    } else {
      const winnerId = (d.creator_outcome === actual) ? d.creator_id : d.opponent_id;
      const pot = d.points * 2;
      await db.prepare('UPDATE users SET points_balance=points_balance+? WHERE id=?').bind(pot, winnerId).run();
      await db.prepare(`INSERT INTO point_ledger (user_id, change, reason) VALUES (?, ?, 'duel_win')`).bind(winnerId, pot).run();
      await db.prepare("UPDATE duels SET status='settled', winner_id=? WHERE id=?").bind(winnerId, d.id).run();
      settled++;
    }
  }
  return jOk({ message: `对赌结算：${settled}局分胜负，${refunded}局退回` });
}

// better-sqlite3包装下的建表（adapter的exec在D1Database上）
function ensureTableSafe(db) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS duels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL, creator_id INTEGER NOT NULL,
      creator_outcome TEXT NOT NULL, points INTEGER NOT NULL,
      opponent_id INTEGER, status TEXT DEFAULT 'open',
      winner_id INTEGER, created_at INTEGER DEFAULT (unixepoch())
    )`);
  } catch (e) {}
}

function jOk(b) { return new Response(JSON.stringify({ success: true, ...b }), { headers: { 'Content-Type': 'application/json' } }); }
function jErr(m, s) { return new Response(JSON.stringify({ success: false, error: m }), { status: s, headers: { 'Content-Type': 'application/json' } }); }
