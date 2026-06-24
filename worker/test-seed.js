// ============================================================
// 真实赛程录入（2026世界杯小组赛第3轮，来自官方赛程截图）
// POST /api/admin/seed-test-matches
//
// 18 场真实对阵，开赛时间为北京时间。
// 队名编码 "中文|English|🇵🇹"，前端拆开显示中英文+国旗。
// 赔率用 odds.js 算法生成（基于预设强弱 rank），不抄外部盘口。
// 重复执行会先清掉旧的 test_ 比赛再重建，方便反复调试。
// ============================================================

import { estimateProbs, multipliersFromProbs, binaryMultipliers } from './odds.js';

// 北京时间 'YYYY-MM-DD HH:MM' -> unix 时间戳
function bjTime(str) {
  const [date, time] = str.split(' ');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  // 北京时间 UTC+8，所以对应 UTC 要减 8 小时
  return Math.floor(Date.UTC(y, mo - 1, d, h - 8, mi) / 1000);
}

// 队名: "中文|English|🇨🇳"，rank 越小越强（FIFA排名近似，用于算赔率）
const FIXTURES = [
  // ---- 6月25日 周四 ----
  { home: '瑞士|Switzerland|🇨🇭', away: '加拿大|Canada|🇨🇦', hr: 19, ar: 48, stage: 'B组 第3轮', time: '2026-06-25 03:00' },
  { home: '波黑|Bosnia|🇧🇦', away: '卡塔尔|Qatar|🇶🇦', hr: 74, ar: 37, stage: 'B组 第3轮', time: '2026-06-25 03:00' },
  { home: '苏格兰|Scotland|🏴', away: '巴西|Brazil|🇧🇷', hr: 39, ar: 5, stage: 'C组 第3轮', time: '2026-06-25 06:00' },
  { home: '摩洛哥|Morocco|🇲🇦', away: '海地|Haiti|🇭🇹', hr: 12, ar: 83, stage: 'C组 第3轮', time: '2026-06-25 06:00' },
  { home: '捷克|Czechia|🇨🇿', away: '墨西哥|Mexico|🇲🇽', hr: 40, ar: 14, stage: 'A组 第3轮', time: '2026-06-25 09:00' },
  { home: '南非|South Africa|🇿🇦', away: '韩国|South Korea|🇰🇷', hr: 60, ar: 23, stage: 'A组 第3轮', time: '2026-06-25 09:00' },
  // ---- 6月26日 周五 ----
  { home: '厄瓜多尔|Ecuador|🇪🇨', away: '德国|Germany|🇩🇪', hr: 31, ar: 10, stage: 'E组 第3轮', time: '2026-06-26 04:00' },
  { home: '库拉索|Curacao|🇨🇼', away: '科特迪瓦|Ivory Coast|🇨🇮', hr: 90, ar: 42, stage: 'E组 第3轮', time: '2026-06-26 04:00' },
  { home: '突尼斯|Tunisia|🇹🇳', away: '荷兰|Netherlands|🇳🇱', hr: 41, ar: 7, stage: 'F组 第3轮', time: '2026-06-26 07:00' },
  { home: '日本|Japan|🇯🇵', away: '瑞典|Sweden|🇸🇪', hr: 17, ar: 33, stage: 'F组 第3轮', time: '2026-06-26 07:00' },
  { home: '土耳其|Turkey|🇹🇷', away: '美国|USA|🇺🇸', hr: 26, ar: 16, stage: 'D组 第3轮', time: '2026-06-26 10:00' },
  { home: '巴拉圭|Paraguay|🇵🇾', away: '澳大利亚|Australia|🇦🇺', hr: 56, ar: 25, stage: 'D组 第3轮', time: '2026-06-26 10:00' },
  // ---- 6月27日 周六 ----
  { home: '挪威|Norway|🇳🇴', away: '法国|France|🇫🇷', hr: 35, ar: 3, stage: 'I组 第3轮', time: '2026-06-27 03:00' },
  { home: '塞内加尔|Senegal|🇸🇳', away: '伊拉克|Iraq|🇮🇶', hr: 18, ar: 58, stage: 'I组 第3轮', time: '2026-06-27 03:00' },
  { home: '乌拉圭|Uruguay|🇺🇾', away: '西班牙|Spain|🇪🇸', hr: 15, ar: 8, stage: 'H组 第3轮', time: '2026-06-27 08:00' },
  { home: '佛得角|Cape Verde|🇨🇻', away: '沙特阿拉伯|Saudi Arabia|🇸🇦', hr: 70, ar: 59, stage: 'H组 第3轮', time: '2026-06-27 08:00' },
  { home: '新西兰|New Zealand|🇳🇿', away: '比利时|Belgium|🇧🇪', hr: 86, ar: 6, stage: 'G组 第3轮', time: '2026-06-27 11:00' },
  { home: '埃及|Egypt|🇪🇬', away: '伊朗|Iran|🇮🇷', hr: 36, ar: 21, stage: 'G组 第3轮', time: '2026-06-27 11:00' },
];

export async function handleSeedTestMatches(request, env) {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);

  const ptypes = {};
  const rows = await db.prepare('SELECT id, code FROM prediction_types').all();
  for (const r of rows.results) ptypes[r.code] = r.id;
  if (!ptypes['match_result'] || !ptypes['both_teams_score']) {
    return jsonError('题型未初始化，请先确认 seed.sql 已执行', 500);
  }

  // 先清掉旧的 test_ 比赛（及其市场、相关预测），方便反复重建
  const oldMatches = await db.prepare("SELECT id FROM matches WHERE external_match_id LIKE 'test_%'").all();
  for (const m of oldMatches.results) {
    await db.prepare('DELETE FROM match_outcome_tiers WHERE match_id=?').bind(m.id).run();
    await db.prepare('DELETE FROM predictions WHERE match_id=?').bind(m.id).run();
    await db.prepare('DELETE FROM matches WHERE id=?').bind(m.id).run();
  }

  const created = [];
  for (let i = 0; i < FIXTURES.length; i++) {
    const fx = FIXTURES[i];
    const extId = 'test_' + now + '_' + i;
    const kickoff = bjTime(fx.time);

    const ins = await db
      .prepare(`INSERT INTO matches (external_match_id, stage, home_team, away_team, kickoff_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')`)
      .bind(extId, fx.stage, fx.home, fx.away, kickoff)
      .run();
    const matchId = ins.meta.last_row_id;

    // 胜平负
    const probs = estimateProbs(fx.hr, fx.ar);
    const mr = multipliersFromProbs(probs);
    const homeCn = fx.home.split('|')[0];
    const awayCn = fx.away.split('|')[0];
    const mrType = ptypes['match_result'];
    for (const [key, label, mult] of [
      ['home_win', `${homeCn}胜`, mr.home_win],
      ['draw', '平局', mr.draw],
      ['away_win', `${awayCn}胜`, mr.away_win],
    ]) {
      await db.prepare(`INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, ?, ?, ?, 10000)`)
        .bind(matchId, mrType, key, label, mult).run();
    }

    // 双方进球
    const closeness = 1 - Math.min(Math.abs(fx.hr - fx.ar) / 30, 0.5);
    const bts = binaryMultipliers(0.45 + 0.15 * closeness);
    const btsType = ptypes['both_teams_score'];
    await db.prepare(`INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, 'yes', '双方都进球', ?, 10000)`).bind(matchId, btsType, bts.yes).run();
    await db.prepare(`INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, 'no', '双方0进球', ?, 10000)`).bind(matchId, btsType, bts.no).run();

    await db.prepare('UPDATE matches SET tiers_locked_at=? WHERE id=?').bind(now, matchId).run();
    created.push({ matchId, match: `${homeCn} vs ${awayCn}`, time: fx.time });
  }

  return jsonOk({ message: `已录入 ${created.length} 场真实赛程`, created });
}

// 手动结算测试比赛（指定比分）
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

function jsonOk(body) { return new Response(JSON.stringify({ success: true, ...body }), { headers: { 'Content-Type': 'application/json' } }); }
function jsonError(message, status) { return new Response(JSON.stringify({ success: false, error: message }), { status, headers: { 'Content-Type': 'application/json' } }); }
