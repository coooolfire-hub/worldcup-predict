// ============================================================
// 录入真实世界杯场次（来自用户提供的 Polymarket 截图）
// POST /api/admin/seed-real-matches
//
// 时间均为北京时间，存储用 unix 时间戳（绝对时间，无时区歧义）。
// 队名中英文都存（home_team 存 "中文 English" 复合，前端再拆分显示）。
// emoji 国旗存在 stage 之外的扩展，前端按队名映射。
// 赔率用 odds.js 算法生成。
// ============================================================

import { estimateProbs, multipliersFromProbs, binaryMultipliers } from './odds.js';

// 北京时间换算成 unix 时间戳的辅助：beijingToTs(2026, 6, 24, 1, 0) = 6月24日北京时间1:00
function beijingToTs(y, mo, d, h, mi) {
  // 北京 = UTC+8，所以 UTC 时间 = 北京时间 - 8 小时
  return Math.floor(Date.UTC(y, mo - 1, d, h - 8, mi, 0) / 1000);
}

// 真实场次（队名: 中文/英文/emoji国旗/FIFA排名用于算赔率）
// rank 越小越强，用于赔率算法；这里用大致的实力档次，不必精确
const REAL_FIXTURES = [
  // 6月24日（北京时间）
  { home: ['葡萄牙','Portugal','🇵🇹',6], away: ['乌兹别克斯坦','Uzbekistan','🇺🇿',57], stage:'小组赛', ts: beijingToTs(2026,6,24,1,0) },
  { home: ['英格兰','England','🏴󠁧󠁢󠁥󠁮󠁧󠁿',4], away: ['加纳','Ghana','🇬🇭',60], stage:'小组赛', ts: beijingToTs(2026,6,24,4,0) },
  { home: ['巴拿马','Panama','🇵🇦',40], away: ['克罗地亚','Croatia','🇭🇷',10], stage:'小组赛', ts: beijingToTs(2026,6,24,7,0) },
  { home: ['哥伦比亚','Colombia','🇨🇴',14], away: ['刚果(金)','DR Congo','🇨🇩',58], stage:'小组赛', ts: beijingToTs(2026,6,24,10,0) },
  // 6月25日（北京时间）
  { home: ['瑞士','Switzerland','🇨🇭',19], away: ['加拿大','Canada','🇨🇦',30], stage:'小组赛', ts: beijingToTs(2026,6,25,3,0) },
  { home: ['波黑','Bosnia-Herzegovina','🇧🇦',39], away: ['卡塔尔','Qatar','🇶🇦',37], stage:'小组赛', ts: beijingToTs(2026,6,25,3,0) },
  { home: ['苏格兰','Scotland','🏴󠁧󠁢󠁳󠁣󠁴󠁿',35], away: ['巴西','Brazil','🇧🇷',5], stage:'小组赛', ts: beijingToTs(2026,6,25,6,0) },
  { home: ['摩洛哥','Morocco','🇲🇦',12], away: ['海地','Haiti','🇭🇹',83], stage:'小组赛', ts: beijingToTs(2026,6,25,6,0) },
];

export async function handleSeedRealMatches(request, env) {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);

  const ptypes = {};
  const rows = await db.prepare('SELECT id, code FROM prediction_types').all();
  for (const r of rows.results) ptypes[r.code] = r.id;
  if (!ptypes['match_result'] || !ptypes['both_teams_score']) {
    return jsonError('题型未初始化', 500);
  }

  // 先清掉之前编的测试比赛（external_match_id 以 test_ 开头的），避免混在一起
  // 注意：连带删除它们的赔率和预测，保持干净
  const oldTests = await db.prepare("SELECT id FROM matches WHERE external_match_id LIKE 'test_%'").all();
  for (const t of oldTests.results) {
    await db.prepare('DELETE FROM match_outcome_tiers WHERE match_id=?').bind(t.id).run();
    await db.prepare('DELETE FROM predictions WHERE match_id=?').bind(t.id).run();
    await db.prepare('DELETE FROM matches WHERE id=?').bind(t.id).run();
  }

  const created = [];
  for (let i = 0; i < REAL_FIXTURES.length; i++) {
    const fx = REAL_FIXTURES[i];
    const [homeCn, homeEn, homeFlag, homeRank] = fx.home;
    const [awayCn, awayEn, awayFlag, awayRank] = fx.away;
    const extId = 'real_' + fx.ts + '_' + i;

    // 已存在就跳过（避免重复录入）
    const exist = await db.prepare('SELECT id FROM matches WHERE external_match_id=?').bind(extId).first();
    if (exist) { created.push({ skipped: `${homeCn} vs ${awayCn}` }); continue; }

    // 队名存成 "中文|英文|emoji" 复合格式，前端拆分；stage 不动
    const homeStr = `${homeCn}|${homeEn}|${homeFlag}`;
    const awayStr = `${awayCn}|${awayEn}|${awayFlag}`;

    const ins = await db.prepare(
      `INSERT INTO matches (external_match_id, stage, home_team, away_team, kickoff_time, status)
       VALUES (?, ?, ?, ?, ?, 'scheduled')`
    ).bind(extId, fx.stage, homeStr, awayStr, fx.ts).run();
    const matchId = ins.meta.last_row_id;

    // 胜平负赔率
    const probs = estimateProbs(homeRank, awayRank);
    const mr = multipliersFromProbs(probs);
    const mrType = ptypes['match_result'];
    const mrRows = [
      ['home_win', `${homeCn}胜`, mr.home_win],
      ['draw', '平局', mr.draw],
      ['away_win', `${awayCn}胜`, mr.away_win],
    ];
    for (const [key, label, mult] of mrRows) {
      await db.prepare(
        `INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap)
         VALUES (?, ?, ?, ?, ?, 10000)`
      ).bind(matchId, mrType, key, label, mult).run();
    }

    // 双方进球
    const closeness = 1 - Math.min(Math.abs(homeRank - awayRank) / 30, 0.5);
    const btsYes = 0.45 + 0.15 * closeness;
    const bts = binaryMultipliers(btsYes);
    const btsType = ptypes['both_teams_score'];
    await db.prepare(`INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, 'yes', '双方都进球', ?, 10000)`)
      .bind(matchId, btsType, bts.yes).run();
    // "非双方都进" 改名为 "双方0进球"
    await db.prepare(`INSERT INTO match_outcome_tiers (match_id, prediction_type_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, 'no', '双方0进球', ?, 10000)`)
      .bind(matchId, btsType, bts.no).run();

    await db.prepare('UPDATE matches SET tiers_locked_at=? WHERE id=?').bind(now, matchId).run();
    created.push({ matchId, match: `${homeCn} vs ${awayCn}` });
  }

  return jsonOk({ message: `已录入 ${created.length} 场真实比赛`, created });
}

function jsonOk(body) {
  return new Response(JSON.stringify({ success: true, ...body }), { headers: { 'Content-Type': 'application/json' } });
}
function jsonError(message, status) {
  return new Response(JSON.stringify({ success: false, error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}
