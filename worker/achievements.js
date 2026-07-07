// ============================================================
// 成就系统
// GET /api/achievements?userId=
//
// 三类成就，每类三档（5/10/20）：
//   - 命中：累计猜中场次（单场 won + 赛事 won）
//   - 失手：累计未命中场次（单场 lost + 赛事 lost）
//   - 坚持：连续登录天数（users.login_streak）
// 返回每个成就的解锁状态和进度。
// ============================================================

const TIERS = [5, 10, 20];

const DEFS = [
  { group: '命中', icon: '🎯', desc: '累计猜中', unit: '场' },
  { group: '失手', icon: '💀', desc: '累计未命中', unit: '场' },
  { group: '坚持', icon: '🔥', desc: '连续登录', unit: '天' },
];

export async function handleAchievements(request, env) {
  const db = env.DB;
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  if (!userId) return jsonOk({ achievements: [], stats: {} });

  // 命中场次（单场 + 赛事）
  const winRow = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM predictions WHERE user_id=? AND status='won')
          + (SELECT COUNT(*) FROM event_predictions WHERE user_id=? AND status='won') AS c`
  ).bind(userId, userId).first();
  const wins = winRow ? winRow.c : 0;

  // 未命中场次（单场 + 赛事）
  const lossRow = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM predictions WHERE user_id=? AND status='lost')
          + (SELECT COUNT(*) FROM event_predictions WHERE user_id=? AND status='lost') AS c`
  ).bind(userId, userId).first();
  const losses = lossRow ? lossRow.c : 0;

  // 连续登录天数
  const user = await db.prepare('SELECT login_streak FROM users WHERE id=?').bind(userId).first();
  const streak = user ? (user.login_streak || 0) : 0;

  const stats = { wins, losses, streak };
  const values = [wins, losses, streak];

  const achievements = [];
  DEFS.forEach((def, gi) => {
    const val = values[gi];
    TIERS.forEach((tier) => {
      achievements.push({
        group: def.group,
        icon: def.icon,
        title: `${def.desc}${tier}${def.unit}`,
        tier,
        current: val,
        unlocked: val >= tier,
        progress: Math.min(100, Math.round((val / tier) * 100)),
      });
    });
  });

  const unlockedCount = achievements.filter(a => a.unlocked).length;
  return jsonOk({ achievements, stats, unlockedCount });
}

function jsonOk(body) {
  return new Response(JSON.stringify({ success: true, ...body }), { headers: { 'Content-Type': 'application/json' } });
}

// 成就排行榜：列出每个用户解锁的成就数
export async function handleAchievementBoard(request, env) {
  const db = env.DB;
  const users = await db.prepare('SELECT id, nickname, login_streak FROM users').all();
  const board = [];
  for (const u of users.results) {
    const w = await db.prepare(`SELECT (SELECT COUNT(*) FROM predictions WHERE user_id=? AND status='won')+(SELECT COUNT(*) FROM event_predictions WHERE user_id=? AND status='won') AS c`).bind(u.id, u.id).first();
    const l = await db.prepare(`SELECT (SELECT COUNT(*) FROM predictions WHERE user_id=? AND status='lost')+(SELECT COUNT(*) FROM event_predictions WHERE user_id=? AND status='lost') AS c`).bind(u.id, u.id).first();
    const vals = [w.c, l.c, u.login_streak || 0];
    let unlocked = 0;
    vals.forEach(v => [5, 10, 20].forEach(t => { if (v >= t) unlocked++; }));
    if (unlocked > 0) board.push({ nickname: u.nickname, unlocked, wins: w.c, losses: l.c, streak: u.login_streak || 0 });
  }
  board.sort((a, b) => b.unlocked - a.unlocked);
  return jsonOk({ board });
}
