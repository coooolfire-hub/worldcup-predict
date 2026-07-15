// ============================================================
// 成就系统 v2：4类多档
// ============================================================
const CATEGORIES = [
  { key: 'streak', name: '累计登录天数', icon: '🔥', unit: '天', tiers: [5, 10, 15, 20, 30] },
  { key: 'wins', name: '累计猜中场次', icon: '🎯', unit: '场', tiers: [5, 10, 15, 20, 30] },
  { key: 'losses', name: '累计未猜中', icon: '💀', unit: '场', tiers: [5, 10, 15, 20, 30] },
  { key: 'score', name: '总得分', icon: '💰', unit: '', tiers: [100000, 200000, 500000, 1000000] },
];

async function getUserStats(db, userId) {
  const winRow = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM predictions WHERE user_id=? AND status='won')
          + (SELECT COUNT(*) FROM event_predictions WHERE user_id=? AND status='won') AS c`
  ).bind(userId, userId).first();
  const lossRow = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM predictions WHERE user_id=? AND status='lost')
          + (SELECT COUNT(*) FROM event_predictions WHERE user_id=? AND status='lost') AS c`
  ).bind(userId, userId).first();
  const user = await db.prepare('SELECT login_streak FROM users WHERE id=?').bind(userId).first();
  const scoreRow = await db.prepare(
    `SELECT COALESCE(SUM(change), 0) AS total FROM point_ledger WHERE user_id=? AND reason IN ('payout','event_payout')`
  ).bind(userId).first();
  return {
    wins: winRow ? winRow.c : 0,
    losses: lossRow ? lossRow.c : 0,
    streak: user ? (user.login_streak || 0) : 0,
    score: scoreRow ? scoreRow.total : 0,
  };
}

function computeAchievements(stats) {
  const achievements = [];
  for (const cat of CATEGORIES) {
    const val = stats[cat.key] || 0;
    for (const tier of cat.tiers) {
      achievements.push({
        group: cat.name,
        icon: cat.icon,
        title: `${cat.name}${tier}${cat.unit}`,
        tier,
        current: val,
        unlocked: val >= tier,
        progress: Math.min(100, Math.round((val / tier) * 100)),
      });
    }
  }
  return achievements;
}

export async function handleAchievements(request, env) {
  const db = env.DB;
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  if (!userId) return jsonOk({ achievements: [], stats: {} });
  const stats = await getUserStats(db, userId);
  const achievements = computeAchievements(stats);
  const unlockedCount = achievements.filter(a => a.unlocked).length;
  return jsonOk({ achievements, stats, unlockedCount });
}

// 成就排行榜：显示每个用户解锁的成就数 + 具体解锁的成就列表
export async function handleAchievementBoard(request, env) {
  const db = env.DB;
  const users = await db.prepare('SELECT id, nickname FROM users').all();
  const board = [];
  for (const u of users.results) {
    const stats = await getUserStats(db, u.id);
    const achievements = computeAchievements(stats);
    const unlocked = achievements.filter(a => a.unlocked);
    if (unlocked.length > 0) {
      board.push({
        userId: u.id,
        nickname: u.nickname,
        unlockedCount: unlocked.length,
        stats,
        unlockedList: unlocked.map(a => a.title),
      });
    }
  }
  board.sort((a, b) => b.unlockedCount - a.unlockedCount);
  return jsonOk({ board });
}

function jsonOk(body) {
  return new Response(JSON.stringify({ success: true, ...body }), { headers: { 'Content-Type': 'application/json' } });
}