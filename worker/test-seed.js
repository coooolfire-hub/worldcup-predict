// ============================================================
// 比赛数据管理（安全版 - 不破坏已有下注）
//
//   POST /api/admin/update-flags     只更新国旗，不碰比赛和下注
//   POST /api/admin/seed-test-matches 新增比赛（已存在的跳过，不删数据）
//   POST /api/admin/settle-test       结算比赛（按比分给下注算输赢发积分）
//
// 比赛唯一性：用 "主队中文+客队中文+开赛时间" 判断是否已存在，
// 已存在就跳过（不重复录入、不删除），只新增没有的。
// 这样反复调用安全，绝不会清掉用户的下注记录。
// ============================================================

import { estimateProbs, multipliersFromProbs, binaryMultipliers } from './odds.js';
import { judgeScore, addScoreTiers } from './score-market.js';

function bjTime(str) {
  const [date, time] = str.split(' ');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d, h - 8, mi) / 1000);
}

// 队名: "中文|English|国家代码"，rank 越小越强
const FIXTURES = [
  // ---- 6月25日 周四 ----
  { home: '瑞士|Switzerland|ch', away: '加拿大|Canada|ca', hr: 19, ar: 48, stage: 'B组 第3轮', time: '2026-06-25 03:00' },
  { home: '波黑|Bosnia|ba', away: '卡塔尔|Qatar|qa', hr: 74, ar: 37, stage: 'B组 第3轮', time: '2026-06-25 03:00' },
  { home: '苏格兰|Scotland|gb-sct', away: '巴西|Brazil|br', hr: 39, ar: 5, stage: 'C组 第3轮', time: '2026-06-25 06:00' },
  { home: '摩洛哥|Morocco|ma', away: '海地|Haiti|ht', hr: 12, ar: 83, stage: 'C组 第3轮', time: '2026-06-25 06:00' },
  { home: '捷克|Czechia|cz', away: '墨西哥|Mexico|mx', hr: 40, ar: 14, stage: 'A组 第3轮', time: '2026-06-25 09:00' },
  { home: '南非|South Africa|za', away: '韩国|South Korea|kr', hr: 60, ar: 23, stage: 'A组 第3轮', time: '2026-06-25 09:00' },
  // ---- 6月26日 周五 ----
  { home: '厄瓜多尔|Ecuador|ec', away: '德国|Germany|de', hr: 31, ar: 10, stage: 'E组 第3轮', time: '2026-06-26 04:00' },
  { home: '库拉索|Curacao|cw', away: '科特迪瓦|Ivory Coast|ci', hr: 90, ar: 42, stage: 'E组 第3轮', time: '2026-06-26 04:00' },
  { home: '突尼斯|Tunisia|tn', away: '荷兰|Netherlands|nl', hr: 41, ar: 7, stage: 'F组 第3轮', time: '2026-06-26 07:00' },
  { home: '日本|Japan|jp', away: '瑞典|Sweden|se', hr: 17, ar: 33, stage: 'F组 第3轮', time: '2026-06-26 07:00' },
  { home: '土耳其|Turkey|tr', away: '美国|USA|us', hr: 26, ar: 16, stage: 'D组 第3轮', time: '2026-06-26 10:00' },
  { home: '巴拉圭|Paraguay|py', away: '澳大利亚|Australia|au', hr: 56, ar: 25, stage: 'D组 第3轮', time: '2026-06-26 10:00' },
  // ---- 6月27日 周六 ----
  { home: '挪威|Norway|no', away: '法国|France|fr', hr: 35, ar: 3, stage: 'I组 第3轮', time: '2026-06-27 03:00' },
  { home: '塞内加尔|Senegal|sn', away: '伊拉克|Iraq|iq', hr: 18, ar: 58, stage: 'I组 第3轮', time: '2026-06-27 03:00' },
  { home: '乌拉圭|Uruguay|uy', away: '西班牙|Spain|es', hr: 15, ar: 8, stage: 'H组 第3轮', time: '2026-06-27 08:00' },
  { home: '佛得角|Cape Verde|cv', away: '沙特阿拉伯|Saudi Arabia|sa', hr: 70, ar: 59, stage: 'H组 第3轮', time: '2026-06-27 08:00' },
  { home: '新西兰|New Zealand|nz', away: '比利时|Belgium|be', hr: 86, ar: 6, stage: 'G组 第3轮', time: '2026-06-27 11:00' },
  { home: '埃及|Egypt|eg', away: '伊朗|Iran|ir', hr: 36, ar: 21, stage: 'G组 第3轮', time: '2026-06-27 11:00' },
];

// ---------- 接口1：只更新国旗（不碰比赛、不碰下注，绝对安全） ----------
// 根据"主队中文+客队中文"匹配已有比赛，只更新 home_team/away_team 字段里的国旗代码
export async function handleUpdateFlags(request, env) {
  const db = env.DB;
  let updated = 0;
  for (const fx of FIXTURES) {
    const homeCn = fx.home.split('|')[0];
    const awayCn = fx.away.split('|')[0];
    // 找现有比赛：主队中文匹配（home_team 以"中文|"开头）
    const matches = await db.prepare(
      "SELECT id, home_team, away_team FROM matches WHERE home_team LIKE ? AND away_team LIKE ?"
    ).bind(homeCn + '|%', awayCn + '|%').all();
    for (const m of matches.results) {
      // 直接把完整的新编码（含国家代码）写回去
      await db.prepare('UPDATE matches SET home_team=?, away_team=? WHERE id=?')
        .bind(fx.home, fx.away, m.id).run();
      updated++;
    }
  }
  return jsonOk({ message: `已更新 ${updated} 场比赛的国旗（未改动任何下注）` });
}

// ---------- 接口2：新增比赛（已存在的跳过，不删任何数据） ----------
export async function handleSeedTestMatches(request, env) {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);

  const ptypes = {};
  const rows = await db.prepare('SELECT id, code FROM prediction_types').all();
  for (const r of rows.results) ptypes[r.code] = r.id;
  if (!ptypes['match_result'] || !ptypes['both_teams_score']) {
    return jsonError('题型未初始化，请先确认 seed.sql 已执行', 500);
  }

  const created = [];
  const skipped = [];

  for (const fx of FIXTURES) {
    const homeCn = fx.home.split('|')[0];
    const awayCn = fx.away.split('|')[0];
    const kickoff = bjTime(fx.time);

    // 判断是否已存在：主队+客队+开赛时间都相同 → 视为同一场，跳过
    const exist = await db.prepare(
      "SELECT id FROM matches WHERE home_team LIKE ? AND away_team LIKE ? AND kickoff_time=?"
    ).bind(homeCn + '|%', awayCn + '|%', kickoff).first();

    if (exist) { skipped.push(`${homeCn} vs ${awayCn}`); continue; }

    // 新比赛才录入
    const extId = 'test_' + now + '_' + Math.random().toString(36).slice(2, 8);
    const ins = await db
      .prepare(`INSERT INTO matches (external_match_id, stage, home_team, away_team, kickoff_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')`)
      .bind(extId, fx.stage, fx.home, fx.away, kickoff)
      .run();
    const matchId = ins.meta.last_row_id;

    const probs = estimateProbs(fx.hr, fx.ar);
    const mr = multipliersFromProbs(probs);
    const mrType = ptypes['match_result'];
    for (const [key, label, mult] of [
      ['home_win', `${homeCn}胜`, mr.home_win],
      ['draw', '平局', mr.draw],
      ['away_win', `${awayCn}胜`, mr.away_win],
    ]) {
      await db.prepare(`INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, ?, ?, ?, 10000)`)
        .bind(matchId, mrType, key, label, mult).run();
    }
    const closeness = 1 - Math.min(Math.abs(fx.hr - fx.ar) / 30, 0.5);
    const bts = binaryMultipliers(0.45 + 0.15 * closeness);
    const btsType = ptypes['both_teams_score'];
    await db.prepare(`INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, 'yes', '双方都进球', ?, 10000)`).bind(matchId, btsType, bts.yes).run();
    await db.prepare(`INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, 'no', '双方0进球', ?, 10000)`).bind(matchId, btsType, bts.no).run();
    await db.prepare('UPDATE matches SET tiers_locked_at=? WHERE id=?').bind(now, matchId).run();

    created.push(`${homeCn} vs ${awayCn}`);
  }

  return jsonOk({
    message: `新增 ${created.length} 场，跳过 ${skipped.length} 场已存在的`,
    created, skipped,
  });
}

// ---------- 接口3：结算（按比分给下注算输赢，正常流程，不破坏数据） ----------
export async function handleSettleTest(request, env) {
  const { matchId, homeScore, awayScore } = await request.json();
  const db = env.DB;
  const match = await db.prepare('SELECT * FROM matches WHERE id=?').bind(matchId).first();
  if (!match) return jsonError('比赛不存在', 404);
  if (match.status === 'finished' || match.status === 'settled') return jsonError('该比赛已结算', 400);

  await db.prepare(`UPDATE matches SET status='finished', home_score=?, away_score=? WHERE id=?`).bind(homeScore, awayScore, matchId).run();

  const typeRows = await db.prepare(`SELECT DISTINCT pt.id, pt.code FROM match_outcome_tiers t JOIN prediction_types pt ON pt.id=t.prediction_type_id WHERE t.match_id=?`).bind(matchId).all();
  const actualByType = {};
  for (const row of typeRows.results) {
    if (row.code === 'match_result') actualByType[row.id] = homeScore > awayScore ? 'home_win' : homeScore < awayScore ? 'away_win' : 'draw';
    else if (row.code === 'both_teams_score') actualByType[row.id] = (homeScore > 0 && awayScore > 0) ? 'yes' : 'no';
    else if (row.code === 'exact_score') actualByType[row.id] = judgeScore(homeScore, awayScore);
  }

  const pending = await db.prepare(`SELECT * FROM predictions WHERE match_id=? AND status='pending'`).bind(matchId).all();
  let settledCount = 0;
  for (const pred of pending.results) {
    const actual = actualByType[pred.prediction_type_id];
    if (actual === undefined) continue;
    const won = actual === pred.outcome_key;
    const payout = won ? Math.round(pred.points_staked * pred.multiplier_locked) : 0;
    await db.prepare(`UPDATE predictions SET status=?, points_awarded=?, settled_at=? WHERE id=?`).bind(won ? 'won' : 'lost', payout, Math.floor(Date.now()/1000), pred.id).run();
    if (won && payout > 0) {
      await db.prepare(`INSERT INTO point_ledger (user_id, change, reason, ref_table, ref_id) VALUES (?, ?, 'payout', 'predictions', ?)`).bind(pred.user_id, payout, pred.id).run();
      await db.prepare('UPDATE users SET points_balance = points_balance + ? WHERE id=?').bind(payout, pred.user_id).run();
    }
    settledCount++;
  }
  await db.prepare('UPDATE matches SET settled_at=? WHERE id=?').bind(Math.floor(Date.now()/1000), matchId).run();
  return jsonOk({ message: `比赛已结算 ${homeScore}:${awayScore}，处理 ${settledCount} 条预测` });
}

// ---------- 后台：列出所有比赛（含状态，供管理页面用） ----------
export async function handleAdminListMatches(request, env) {
  const db = env.DB;
  const rows = await db.prepare(
    `SELECT id, home_team, away_team, stage, kickoff_time, status, home_score, away_score
     FROM matches ORDER BY kickoff_time ASC`
  ).all();
  const now = Math.floor(Date.now() / 1000);
  const matches = rows.results.map(m => ({
    id: m.id,
    home: (m.home_team || '').split('|')[0],
    away: (m.away_team || '').split('|')[0],
    homeFlag: (m.home_team || '').split('|')[2] || '',
    awayFlag: (m.away_team || '').split('|')[2] || '',
    stage: m.stage,
    kickoffTime: m.kickoff_time,
    status: m.status,
    started: now >= m.kickoff_time,
    homeScore: m.home_score,
    awayScore: m.away_score,
  }));
  return jsonOk({ matches });
}

// ---------- 后台：添加单场比赛（自动生成赔率） ----------
// body: { home, homeEn, homeFlag, away, awayEn, awayFlag, homeRank, awayRank, stage, time }
// time 格式 "2026-06-28 03:00"（北京时间）
export async function handleAddMatch(request, env) {
  const b = await request.json();
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);

  if (!b.home || !b.away || !b.time) return jsonError('队名和时间必填', 400);

  const ptypes = {};
  const rows = await db.prepare('SELECT id, code FROM prediction_types').all();
  for (const r of rows.results) ptypes[r.code] = r.id;

  // 队名编码 "中文|English|代码"
  const homeEnc = `${b.home}|${b.homeEn || ''}|${b.homeFlag || ''}`;
  const awayEnc = `${b.away}|${b.awayEn || ''}|${b.awayFlag || ''}`;
  const kickoff = bjTime(b.time);
  const hr = b.homeRank || 30, ar = b.awayRank || 30;

  // 防重复：同队同时间已存在则拒绝
  const exist = await db.prepare(
    "SELECT id FROM matches WHERE home_team LIKE ? AND away_team LIKE ? AND kickoff_time=?"
  ).bind(b.home + '|%', b.away + '|%', kickoff).first();
  if (exist) return jsonError('该比赛已存在', 409);

  const ins = await db.prepare(
    `INSERT INTO matches (external_match_id, stage, home_team, away_team, kickoff_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')`
  ).bind('manual_' + now + '_' + Math.random().toString(36).slice(2, 8), b.stage || '', homeEnc, awayEnc, kickoff).run();
  const matchId = ins.meta.last_row_id;

  const probs = estimateProbs(hr, ar);
  const mr = multipliersFromProbs(probs);
  const mrType = ptypes['match_result'];
  for (const [key, label, mult] of [
    ['home_win', `${b.home}胜`, mr.home_win],
    ['draw', '平局', mr.draw],
    ['away_win', `${b.away}胜`, mr.away_win],
  ]) {
    await db.prepare(`INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, ?, ?, ?, 10000)`)
      .bind(matchId, mrType, key, label, mult).run();
  }
  const closeness = 1 - Math.min(Math.abs(hr - ar) / 30, 0.5);
  const bts = binaryMultipliers(0.45 + 0.15 * closeness);
  const btsType = ptypes['both_teams_score'];
  await db.prepare(`INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, 'yes', '双方都进球', ?, 10000)`).bind(matchId, btsType, bts.yes).run();
  await db.prepare(`INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, 'no', '双方0进球', ?, 10000)`).bind(matchId, btsType, bts.no).run();
  await db.prepare('UPDATE matches SET tiers_locked_at=? WHERE id=?').bind(now, matchId).run();

  // 自动加上猜比分玩法
  try { await addScoreTiers(db, matchId); } catch (e) {}

  return jsonOk({ message: `已添加 ${b.home} vs ${b.away}（含比分玩法）`, matchId });
}

function jsonOk(body) { return new Response(JSON.stringify({ success: true, ...body }), { headers: { 'Content-Type': 'application/json' } }); }
function jsonError(message, status) { return new Response(JSON.stringify({ success: false, error: message }), { status, headers: { 'Content-Type': 'application/json' } }); }
