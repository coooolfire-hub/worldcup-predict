// ============================================================
// 前端读取数据用的查询接口（GET）
// 之前后端只有写接口，前端展示需要这几个读接口配套
// ============================================================

// GET /api/markets  —— 市场列表（首页用）
// 返回所有还没开赛、且赔率已锁定的比赛，连带每个结果的当前预测分布
export async function handleMarkets(request, env) {
  const db = env.DB;

  const matches = await db
    .prepare(
      `SELECT * FROM matches
       WHERE status = 'scheduled' AND tiers_locked_at IS NOT NULL
       ORDER BY kickoff_time ASC`
    )
    .all();

  const result = [];
  for (const match of matches.results) {
    const tiers = await db
      .prepare(
        `SELECT t.*, pt.code AS ptype_code, pt.name AS ptype_name
         FROM match_outcome_tiers t
         JOIN prediction_types pt ON pt.id = t.prediction_type_id
         WHERE t.match_id = ?`
      )
      .bind(match.id)
      .all();

    // 计算每个结果的预测分布（多少人押了这个选项），用于展示百分比
    const distribution = await db
      .prepare(
        `SELECT outcome_key, COUNT(*) AS cnt, COALESCE(SUM(points_staked), 0) AS total_pts
         FROM predictions
         WHERE match_id = ? AND status = 'pending'
         GROUP BY outcome_key`
      )
      .bind(match.id)
      .all();

    const distMap = {};
    let totalPredictors = 0;
    for (const d of distribution.results) {
      distMap[d.outcome_key] = d.cnt;
      totalPredictors += d.cnt;
    }

    // 队名可能是 "中文|英文|emoji" 复合格式，拆出来；旧数据没有分隔符就原样用
    const parseTeam = (s) => {
      const parts = (s || '').split('|');
      if (parts.length >= 3) return { cn: parts[0], en: parts[1], flag: parts[2] };
      return { cn: s, en: '', flag: '' };
    };
    const home = parseTeam(match.home_team);
    const away = parseTeam(match.away_team);

    result.push({
      id: match.id,
      stage: match.stage,
      homeTeam: home.cn,
      homeTeamEn: home.en,
      homeFlag: home.flag,
      awayTeam: away.cn,
      awayTeamEn: away.en,
      awayFlag: away.flag,
      kickoffTime: match.kickoff_time,
      totalPredictors,
      tiers: tiers.results.map((t) => ({
        predictionTypeCode: t.ptype_code,
        predictionTypeName: t.ptype_name,
        outcomeKey: t.outcome_key,
        outcomeLabel: t.outcome_label,
        multiplier: t.multiplier,
        stakeCap: t.stake_cap,
        sharePct:
          totalPredictors > 0
            ? Math.round(((distMap[t.outcome_key] || 0) / totalPredictors) * 100)
            : 0,
      })),
    });
  }

  return jsonOk({ markets: result });
}

// GET /api/me?userId=  —— 当前用户信息（余额、连胜、成就）
export async function handleMe(request, env) {
  const db = env.DB;
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!user) return jsonError('用户不存在', 404);

  const streak = await db
    .prepare('SELECT * FROM user_streaks WHERE user_id = ?')
    .bind(userId)
    .first();

  const achievements = await db
    .prepare(
      `SELECT a.code, a.name, a.description, ua.unlocked_at
       FROM user_achievements ua
       JOIN achievements a ON a.id = ua.achievement_id
       WHERE ua.user_id = ?
       ORDER BY ua.unlocked_at DESC`
    )
    .bind(userId)
    .all();

  return jsonOk({
    id: user.id,
    nickname: user.nickname,
    pointsBalance: user.points_balance,
    currentStreak: streak ? streak.current_streak : 0,
    bestStreak: streak ? streak.best_streak : 0,
    achievements: achievements.results,
  });
}

// GET /api/my-predictions?userId=  —— 我的预测记录（"我的"页面用）
export async function handleMyPredictions(request, env) {
  const db = env.DB;
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

  const rows = await db
    .prepare(
      `SELECT p.*, m.home_team, m.away_team, m.stage, m.home_score, m.away_score,
              t.outcome_label
       FROM predictions p
       JOIN matches m ON m.id = p.match_id
       LEFT JOIN match_outcome_tiers t
         ON t.match_id = p.match_id
        AND t.prediction_type_id = p.prediction_type_id
        AND t.outcome_key = p.outcome_key
       WHERE p.user_id = ?
       ORDER BY p.created_at DESC
       LIMIT 50`
    )
    .bind(userId)
    .all();

  return jsonOk({ predictions: rows.results });
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

// GET /api/event-markets —— 赛事级市场列表（夺冠、金靴）
export async function handleEventMarkets(request, env) {
  const db = env.DB;
  const markets = await db
    .prepare("SELECT * FROM event_markets WHERE status='open' ORDER BY id")
    .all();

  const result = [];
  for (const m of markets.results) {
    const options = await db
      .prepare('SELECT outcome_key, outcome_label, multiplier, stake_cap FROM event_market_options WHERE market_id=? ORDER BY multiplier ASC')
      .bind(m.id)
      .all();

    // 预测分布：多少人押了各选项
    const dist = await db
      .prepare(`SELECT outcome_key, COUNT(*) AS cnt FROM event_predictions WHERE market_id=? AND status='pending' GROUP BY outcome_key`)
      .bind(m.id)
      .all();
    const distMap = {};
    let total = 0;
    for (const d of dist.results) { distMap[d.outcome_key] = d.cnt; total += d.cnt; }

    result.push({
      id: m.id,
      marketCode: m.market_code,
      title: m.title,
      totalPredictors: total,
      options: options.results.map((o) => ({
        outcomeKey: o.outcome_key,
        outcomeLabel: o.outcome_label,
        multiplier: o.multiplier,
        stakeCap: o.stake_cap,
        sharePct: total > 0 ? Math.round(((distMap[o.outcome_key] || 0) / total) * 100) : 0,
      })),
    });
  }
  return new Response(JSON.stringify({ success: true, markets: result }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
