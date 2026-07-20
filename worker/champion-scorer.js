// ============================================================
// 夺冠 + 金靴市场录入（手动数据，来自 Polymarket 截图）
//   POST /api/admin/seed-champion-scorer
//
// 数据来自截图的百分比，赔率 = 1/概率 × (1-抽水)，抽水8%，
// 钳制在 1.15 ~ 50 倍之间（冷门可以很高）。
// 截止下注时间：北京时间 2026-07-10 00:00。
// 重复调用：已存在就跳过，不删数据（保护已有下注）。
// ============================================================

function bjTime(str) {
  const [date, time] = str.split(' ');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d, h - 8, mi) / 1000);
}

// 概率(%) → 倍率，抽水8%
function probToMult(pct) {
  const p = pct / 100;
  if (p <= 0) return 50;
  let m = (1 / p) * 0.92;
  return Math.max(1.15, Math.min(50, Math.round(m * 100) / 100));
}

// 夺冠：截图10国 + 国旗代码
const CHAMPIONS = [
  { key: 'fr', label: '法国', flag: 'fr', pct: 19 },
  { key: 'ar', label: '阿根廷', flag: 'ar', pct: 16 },
  { key: 'es', label: '西班牙', flag: 'es', pct: 14 },
  { key: 'gb-eng', label: '英格兰', flag: 'gb-eng', pct: 11 },
  { key: 'pt', label: '葡萄牙', flag: 'pt', pct: 8 },
  { key: 'nl', label: '荷兰', flag: 'nl', pct: 5 },
  { key: 'de', label: '德国', flag: 'de', pct: 5 },
  { key: 'br', label: '巴西', flag: 'br', pct: 5 },
  { key: 'us', label: '美国', flag: 'us', pct: 3 },
  { key: 'no', label: '挪威', flag: 'no', pct: 3 },
];

// 金靴：截图球员（无国旗，用球员名）
const SCORERS = [
  { key: 'messi', label: '莱昂内尔·梅西', pct: 36 },
  { key: 'mbappe', label: '姆巴佩', pct: 31 },
  { key: 'haaland', label: '埃尔林·哈兰德', pct: 10 },
  { key: 'kane', label: '哈里·凯恩', pct: 7 },
  { key: 'vinicius', label: '维尼修斯·儒尼奥尔', pct: 7 },
  { key: 'oyarzabal', label: '米克尔·奥亚萨瓦尔', pct: 3 },
  { key: 'ronaldo', label: '克里斯蒂亚诺·罗纳尔多', pct: 2 },
  { key: 'wirtz', label: '德尼兹·云达夫', pct: 2 },
  { key: 'yamal', label: '拉明·亚马尔', pct: 1 },
  { key: 'gakpo', label: '科迪·加克波', pct: 1 },
  { key: 'havertz', label: '凯·哈弗茨', pct: 0.5 },
  { key: 'palmer', label: '科拉林·巴洛贡', pct: 0.5 },
];

export async function handleSeedChampionScorer(request, env) {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const closeTime = bjTime('2026-07-10 00:00');
  const result = { champion: '', scorer: '' };

  // ---------- 夺冠 ----------
  const champExist = await db.prepare("SELECT id FROM event_markets WHERE market_code='champion'").first();
  if (champExist) {
    result.champion = '已存在，跳过';
  } else {
    const ins = await db.prepare(
      `INSERT INTO event_markets (market_code, title, status, tiers_locked_at, close_time) VALUES ('champion', '谁能夺得本届世界杯冠军？', 'open', ?, ?)`
    ).bind(now, closeTime).run();
    const mid = ins.meta.last_row_id;
    for (const o of CHAMPIONS) {
      await db.prepare(
        `INSERT INTO event_market_options (market_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, ?, ?, 10000)`
      ).bind(mid, o.key, `${o.label}|${o.flag}`, probToMult(o.pct)).run();
    }
    result.champion = `已创建，${CHAMPIONS.length} 个选项`;
  }

  // ---------- 金靴 ----------
  const scorerExist = await db.prepare("SELECT id FROM event_markets WHERE market_code='top_scorer'").first();
  if (scorerExist) {
    result.scorer = '已存在，跳过';
  } else {
    const ins = await db.prepare(
      `INSERT INTO event_markets (market_code, title, status, tiers_locked_at, close_time) VALUES ('top_scorer', '谁能获得本届世界杯金靴奖？', 'open', ?, ?)`
    ).bind(now, closeTime).run();
    const mid = ins.meta.last_row_id;
    for (const o of SCORERS) {
      await db.prepare(
        `INSERT INTO event_market_options (market_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, ?, ?, 10000)`
      ).bind(mid, o.key, o.label, probToMult(o.pct)).run();
    }
    result.scorer = `已创建，${SCORERS.length} 个选项`;
  }

  return jsonOk({ message: '夺冠/金靴市场处理完成', result });
}

// ---------- 后台：编辑赛事市场（改赔率、改截止时间） ----------
// body: { marketId, closeTime?, options?: [{outcome_key, multiplier}] }
export async function handleEditEventMarket(request, env) {
  const b = await request.json();
  const db = env.DB;
  if (!b.marketId) return jsonError('缺少 marketId', 400);

  if (b.closeTime) {
    // closeTime 传北京时间字符串 "2026-07-10 00:00"
    const ts = bjTime(b.closeTime);
    await db.prepare('UPDATE event_markets SET close_time=? WHERE id=?').bind(ts, b.marketId).run();
  }
  if (Array.isArray(b.options)) {
    for (const o of b.options) {
      if (o.outcome_key && o.multiplier) {
        await db.prepare('UPDATE event_market_options SET multiplier=? WHERE market_id=? AND outcome_key=?')
          .bind(o.multiplier, b.marketId, o.outcome_key).run();
      }
    }
  }
  return jsonOk({ message: '市场已更新' });
}

// ---------- 后台：列出赛事市场（含选项，供编辑用） ----------
export async function handleListEventMarkets(request, env) {
  const db = env.DB;
  const markets = await db.prepare("SELECT * FROM event_markets ORDER BY id").all();
  const out = [];
  for (const m of markets.results) {
    const opts = await db.prepare("SELECT outcome_key, outcome_label, multiplier FROM event_market_options WHERE market_id=? ORDER BY multiplier ASC").bind(m.id).all();
    out.push({
      id: m.id, code: m.market_code, title: m.title, status: m.status,
      closeTime: m.close_time, winnerKey: m.winner_key,
      options: opts.results,
    });
  }
  return jsonOk({ markets: out });
}

// ---------- 后台：结算赛事市场（选出获胜选项） ----------
export async function handleSettleEventMarket(request, env) {
  const { marketId, winnerKey } = await request.json();
  const db = env.DB;
  const market = await db.prepare("SELECT * FROM event_markets WHERE id=?").bind(marketId).first();
  if (!market) return jsonError('市场不存在', 404);
  if (market.status === 'settled') return jsonError('该市场已结算', 400);

  await db.prepare("UPDATE event_markets SET status='settled', winner_key=?, settled_at=? WHERE id=?")
    .bind(winnerKey, Math.floor(Date.now()/1000), marketId).run();

  const preds = await db.prepare("SELECT * FROM event_predictions WHERE market_id=? AND status='pending'").bind(marketId).all();
  let settled = 0;
  for (const p of preds.results) {
    const won = p.outcome_key === winnerKey;
    const payout = won ? Math.round(p.points_staked * p.multiplier_locked) : 0;
    await db.prepare("UPDATE event_predictions SET status=?, points_awarded=?, settled_at=? WHERE id=?")
      .bind(won ? 'won' : 'lost', payout, Math.floor(Date.now()/1000), p.id).run();
    if (won && payout > 0) {
      await db.prepare("INSERT INTO point_ledger (user_id, change, reason, ref_table, ref_id) VALUES (?, ?, 'event_payout', 'event_predictions', ?)").bind(p.user_id, payout, p.id).run();
      await db.prepare("UPDATE users SET points_balance = points_balance + ? WHERE id=?").bind(payout, p.user_id).run();
    }
    settled++;
  }
  return jsonOk({ message: `市场已结算，处理 ${settled} 条预测` });
}

// ---------- 后台：修正已结算的赛事市场（夺冠/金靴填错获胜选项） ----------
// body: { marketId, winnerKey }
// 逻辑和比分修正一致：撤销旧结算发的积分，退回pending，按新的获胜key重新结算
export async function handleCorrectEventMarket(request, env) {
  const { marketId, winnerKey } = await request.json();
  const db = env.DB;
  if (!marketId || !winnerKey) return jsonError('缺少 marketId / winnerKey', 400);

  const market = await db.prepare("SELECT * FROM event_markets WHERE id=?").bind(marketId).first();
  if (!market) return jsonError('市场不存在', 404);
  if (market.status !== 'settled') return jsonError('该市场还没结算，直接填获胜key点结算即可，不用走这个接口', 400);
  if (market.winner_key === winnerKey) return jsonError('新的获胜key和原来一样，无需修改', 400);

  const oldWinner = market.winner_key;

  // 1) 撤销旧结算
  const settledPreds = await db.prepare(
    "SELECT * FROM event_predictions WHERE market_id=? AND status IN ('won','lost')"
  ).bind(marketId).all();

  let reversedCount = 0;
  let reversedPoints = 0;
  for (const pred of settledPreds.results) {
    if (pred.points_awarded > 0) {
      await db.prepare(
        "INSERT INTO point_ledger (user_id, change, reason, ref_table, ref_id) VALUES (?, ?, 'event_payout', 'event_predictions', ?)"
      ).bind(pred.user_id, -pred.points_awarded, pred.id).run();
      await db.prepare('UPDATE users SET points_balance = points_balance - ? WHERE id=?')
        .bind(pred.points_awarded, pred.user_id).run();
      reversedPoints += pred.points_awarded;
    }
    await db.prepare("UPDATE event_predictions SET status='pending', points_awarded=0, settled_at=NULL WHERE id=?")
      .bind(pred.id).run();
    reversedCount++;
  }

  // 2) 写入正确的获胜key
  await db.prepare("UPDATE event_markets SET status='settled', winner_key=?, settled_at=? WHERE id=?")
    .bind(winnerKey, Math.floor(Date.now() / 1000), marketId).run();

  // 3) 按新获胜key重新结算
  const pending = await db.prepare("SELECT * FROM event_predictions WHERE market_id=? AND status='pending'").bind(marketId).all();
  let settledCount = 0;
  let newPayoutTotal = 0;
  for (const p of pending.results) {
    const won = p.outcome_key === winnerKey;
    const payout = won ? Math.round(p.points_staked * p.multiplier_locked) : 0;
    await db.prepare("UPDATE event_predictions SET status=?, points_awarded=?, settled_at=? WHERE id=?")
      .bind(won ? 'won' : 'lost', payout, Math.floor(Date.now() / 1000), p.id).run();
    if (won && payout > 0) {
      await db.prepare("INSERT INTO point_ledger (user_id, change, reason, ref_table, ref_id) VALUES (?, ?, 'event_payout', 'event_predictions', ?)")
        .bind(p.user_id, payout, p.id).run();
      await db.prepare('UPDATE users SET points_balance = points_balance + ? WHERE id=?').bind(payout, p.user_id).run();
      newPayoutTotal += payout;
    }
    settledCount++;
  }

  return jsonOk({
    message: `获胜选项已从 ${oldWinner} 改为 ${winnerKey}，撤销旧结算 ${reversedCount} 条（追回 ${reversedPoints} 积分），重新结算 ${settledCount} 条（发放 ${newPayoutTotal} 积分）`,
  });
}

function jsonOk(body) { return new Response(JSON.stringify({ success: true, ...body }), { headers: { 'Content-Type': 'application/json' } }); }
function jsonError(message, status) { return new Response(JSON.stringify({ success: false, error: message }), { status, headers: { 'Content-Type': 'application/json' } }); }
