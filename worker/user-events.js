// ============================================================
// 用户投稿事件
//   POST /api/submit-event        用户提交事件（待审核）
//   POST /api/admin/list-pending  后台列出待审事件
//   POST /api/admin/review-event  后台审核（通过/拒绝）
//
// 复用 event_markets / event_market_options 表，
// source='user', review_status='pending'/'approved'/'rejected', category='other'
// ============================================================

// 用户提交事件：标题 + 2~6个选项（赔率统一给中等值，后台审核时可改）
export async function handleSubmitEvent(request, env) {
  const { userId, title, options } = await request.json();
  const db = env.DB;
  if (!userId) return jsonErr('请先登录', 401);
  if (!title || title.length < 4) return jsonErr('标题至少4个字', 400);
  if (!Array.isArray(options) || options.length < 2) return jsonErr('至少2个选项', 400);
  if (options.length > 6) return jsonErr('最多6个选项', 400);

  // 防刷：同一用户待审事件不超过3个
  const pendingCount = await db.prepare(
    "SELECT COUNT(*) AS c FROM event_markets WHERE submitter_id=? AND review_status='pending'"
  ).bind(userId).first();
  if (pendingCount.c >= 3) return jsonErr('你有太多待审事件，请等审核后再提交', 400);

  const now = Math.floor(Date.now() / 1000);
  const code = 'user_' + now + '_' + Math.random().toString(36).slice(2, 6);
  const ins = await db.prepare(
    `INSERT INTO event_markets (market_code, title, status, tiers_locked_at, source, submitter_id, review_status, category)
     VALUES (?, ?, 'open', ?, 'user', ?, 'pending', 'other')`
  ).bind(code, title, now, userId).run();
  const mid = ins.meta.last_row_id;

  // 选项赔率默认按平均分配（n个选项，每个约 n×0.9 倍），后台审核时可改
  const defaultMult = Math.max(1.5, Math.round(options.length * 0.9 * 100) / 100);
  for (let i = 0; i < options.length; i++) {
    const label = String(options[i]).slice(0, 30);
    await db.prepare(
      `INSERT INTO event_market_options (market_id, outcome_key, outcome_label, multiplier, stake_cap) VALUES (?, ?, ?, ?, 10000)`
    ).bind(mid, 'opt' + i, label, defaultMult).run();
  }
  return jsonOk({ message: '已提交，等待管理员审核' });
}

// 用户看自己的投稿（含审核状态）
export async function handleMySubmissions(request, env) {
  const db = env.DB;
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  if (!userId) return jsonOk({ submissions: [] });
  const rows = await db.prepare(
    "SELECT id, title, review_status, created_at FROM event_markets WHERE submitter_id=? ORDER BY id DESC"
  ).bind(userId).all();
  return jsonOk({ submissions: rows.results });
}

// 后台：列出待审事件（含选项）
export async function handleListPending(request, env) {
  const db = env.DB;
  const markets = await db.prepare(
    "SELECT * FROM event_markets WHERE source='user' AND review_status='pending' ORDER BY id"
  ).all();
  const out = [];
  for (const m of markets.results) {
    const opts = await db.prepare("SELECT outcome_key, outcome_label, multiplier FROM event_market_options WHERE market_id=?").bind(m.id).all();
    out.push({ id: m.id, title: m.title, submitterId: m.submitter_id, options: opts.results });
  }
  return jsonOk({ pending: out });
}

// 后台：审核事件（通过/拒绝），通过时可顺带改赔率
export async function handleReviewEvent(request, env) {
  const { marketId, action, options } = await request.json();
  const db = env.DB;
  if (!marketId || !['approve', 'reject'].includes(action)) return jsonErr('参数错误', 400);

  if (action === 'reject') {
    await db.prepare("UPDATE event_markets SET review_status='rejected' WHERE id=?").bind(marketId).run();
    return jsonOk({ message: '已拒绝' });
  }
  // 通过：可改赔率
  if (Array.isArray(options)) {
    for (const o of options) {
      if (o.outcome_key && o.multiplier) {
        await db.prepare("UPDATE event_market_options SET multiplier=? WHERE market_id=? AND outcome_key=?")
          .bind(o.multiplier, marketId, o.outcome_key).run();
      }
    }
  }
  await db.prepare("UPDATE event_markets SET review_status='approved' WHERE id=?").bind(marketId).run();
  return jsonOk({ message: '已通过，事件已上线' });
}

function jsonOk(b) { return new Response(JSON.stringify({ success: true, ...b }), { headers: { 'Content-Type': 'application/json' } }); }
function jsonErr(m, s) { return new Response(JSON.stringify({ success: false, error: m }), { status: s, headers: { 'Content-Type': 'application/json' } }); }
