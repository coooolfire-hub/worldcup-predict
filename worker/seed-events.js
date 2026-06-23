// ============================================================
// 赛事级市场初始化（夺冠预测、金靴）
// 管理员调用 POST /api/admin/seed-events 触发。
//
// 夺冠市场：拉所有参赛球队，用算法给每队一个夺冠概率→倍率。
// 金靴市场：内测阶段球员数据未必拿得到，做成"可开关"：
//   拿不到射手榜就不建金靴市场，只建夺冠市场，不报错。
// ============================================================

import { fetchAllFixtures, fetchTopScorers } from './sports-api.js';
import { multiOptionMultipliers } from './odds.js';

export async function seedEventMarkets(env) {
  const db = env.DB;
  const apiKey = env.SPORTS_API_KEY;
  const summary = { championCreated: false, topScorerCreated: false, notes: [] };

  // ---------- 夺冠市场 ----------
  const existingChamp = await db
    .prepare("SELECT id FROM event_markets WHERE market_code='champion' AND status='open'")
    .first();

  if (existingChamp) {
    summary.notes.push('夺冠市场已存在，跳过');
  } else {
    // 从赛程里抽出所有不重复的球队
    const fixtures = await fetchAllFixtures(apiKey);
    const teamMap = {};
    for (const f of fixtures) {
      teamMap[f.homeTeamId] = f.homeTeam;
      teamMap[f.awayTeamId] = f.awayTeam;
    }
    const teams = Object.entries(teamMap); // [ [id, name], ... ]

    if (teams.length === 0) {
      summary.notes.push('未拉到球队，夺冠市场未创建');
    } else {
      // 初始概率：内测阶段没有真实战力数据，先给所有队一个均等概率，
      // 再根据是否传统强队做轻微加权（这里用一个简单的"种子队"名单加权）。
      // 等有真实排名后可改成按 FIFA 排名加权。
      const SEEDS = ['巴西', 'Brazil', '阿根廷', 'Argentina', '法国', 'France', '英格兰', 'England', '西班牙', 'Spain', '德国', 'Germany'];
      const options = teams.map(([id, name]) => ({
        key: String(id),
        label: name,
        prob: SEEDS.includes(name) ? 2.0 : 1.0, // 强队权重翻倍
      }));
      const mults = multiOptionMultipliers(options);
      const multByKey = Object.fromEntries(mults.map((m) => [m.key, m.multiplier]));

      const ins = await db
        .prepare(
          `INSERT INTO event_markets (market_code, title, status, tiers_locked_at)
           VALUES ('champion', '谁能夺得本届世界杯冠军？', 'open', ?)`
        )
        .bind(Math.floor(Date.now() / 1000))
        .run();
      const marketId = ins.meta.last_row_id;

      for (const opt of options) {
        await db
          .prepare(
            `INSERT INTO event_market_options (market_id, outcome_key, outcome_label, multiplier, stake_cap)
             VALUES (?, ?, ?, ?, 10000)`
          )
          .bind(marketId, opt.key, opt.label, multByKey[opt.key])
          .run();
      }
      summary.championCreated = true;
      summary.notes.push(`夺冠市场已创建，${options.length} 支球队`);
    }
  }

  // ---------- 金靴市场（可开关） ----------
  const existingTS = await db
    .prepare("SELECT id FROM event_markets WHERE market_code='top_scorer' AND status='open'")
    .first();

  if (existingTS) {
    summary.notes.push('金靴市场已存在，跳过');
  } else {
    try {
      const scorers = await fetchTopScorers(apiKey);
      if (!scorers || scorers.length === 0) {
        summary.notes.push('射手榜暂无数据，金靴市场未创建（赛事初期正常）');
      } else {
        // 取前若干名做选项（太多没意义），概率按当前进球数加权
        const top = scorers.slice(0, 15);
        const options = top.map((s) => ({
          key: s.playerId,
          label: s.playerName,
          prob: Math.max(s.goals, 1),
        }));
        const mults = multiOptionMultipliers(options);
        const multByKey = Object.fromEntries(mults.map((m) => [m.key, m.multiplier]));

        const ins = await db
          .prepare(
            `INSERT INTO event_markets (market_code, title, status, tiers_locked_at)
             VALUES ('top_scorer', '谁是本届世界杯金靴（进球最多）？', 'open', ?)`
          )
          .bind(Math.floor(Date.now() / 1000))
          .run();
        const marketId = ins.meta.last_row_id;
        for (const opt of options) {
          await db
            .prepare(
              `INSERT INTO event_market_options (market_id, outcome_key, outcome_label, multiplier, stake_cap)
               VALUES (?, ?, ?, ?, 10000)`
            )
            .bind(marketId, opt.key, opt.label, multByKey[opt.key])
            .run();
        }
        summary.topScorerCreated = true;
        summary.notes.push(`金靴市场已创建，${options.length} 名球员`);
      }
    } catch (e) {
      // 免费套餐不支持 topscorers 接口时走这里，不影响夺冠市场
      summary.notes.push('射手榜接口不可用（可能套餐限制），金靴市场跳过');
    }
  }

  return summary;
}
