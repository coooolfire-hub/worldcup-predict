// ============================================================
// Worker 主入口
// wrangler.toml 配置:
//   - D1 binding: DB
//   - secret: SPORTS_API_KEY, ADMIN_TOKEN
//   - cron: 频率可低（只拉结果，不要实时），如 "0 */2 * * *" 每2小时
// ============================================================

import { handlePredict } from './predict.js';
import { handleDailyGrant } from './daily-grant.js';
import { runSettlement } from './settle.js';
import { handleLeaderboard } from './leaderboard.js';
import { handleAchievements, handleAchievementBoard } from './achievements.js';
import { handleMarkets, handleMe, handleMyPredictions, handleEventMarkets } from './queries.js';
import { handleRegister, handleLogin, handleSession, handleAdminResetPassword } from './auth.js';
import { handleEventPredict } from './predict.js';
import { syncMatches } from './sync.js';
import { seedEventMarkets } from './seed-events.js';
import { handleSeedTestMatches, handleSettleTest, handleUpdateFlags, handleAdminListMatches, handleAddMatch } from './test-seed.js';
import { handleSeedRealMatches } from './real-seed.js';
import { ADMIN_HTML } from './admin-html.js';
import { handleSeedChampionScorer, handleEditEventMarket, handleListEventMarkets, handleSettleEventMarket } from './champion-scorer.js';
import { handleListUsers, handleDeleteUser, handleGrantPoints } from './user-admin.js';
import { handleSubmitEvent, handleMySubmissions, handleListPending, handleReviewEvent } from './user-events.js';
import { handleAddScoreMarket, handleAddScoreAll } from './score-market.js';
import { handleDuelCreate, handleDuelAccept, handleDuelCancel, handleDuelList, handleSettleDuels } from './duel.js';
import { FRONTEND_HTML } from './frontend-html.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }
    const resp = await route(request, env, url);
    resp.headers.set('Access-Control-Allow-Origin', '*');
    return resp;
  },

  async scheduled(event, env, ctx) {
    // 定时只做结算（拉结果+发积分）。同步比赛由管理员手动触发，
    // 因为赛程不常变，没必要高频拉。
    const summary = await runSettlement(env);
    console.log('结算任务完成:', JSON.stringify(summary));
  },
};

export async function route(request, env, url) {
  const p = url.pathname;
  const GET = request.method === 'GET';
  const POST = request.method === 'POST';

  // -------- 前端页面（根路径返回HTML，走 .workers.dev 域名访问） --------
  if (GET && (p === '/' || p === '/index.html' || p === '/app')) {
    return new Response(FRONTEND_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  // 管理后台页面（前端会要求输入 ADMIN_TOKEN）
  if (GET && (p === '/admin' || p === '/admin.html')) {
    return new Response(ADMIN_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // -------- 读接口 --------
  if (GET && p === '/api/markets') return handleMarkets(request, env);
  if (GET && p === '/api/event-markets') return handleEventMarkets(request, env);
  if (POST && p === '/api/submit-event') return handleSubmitEvent(request, env);
  if (POST && p === '/api/duel-create') return handleDuelCreate(request, env);
  if (POST && p === '/api/duel-accept') return handleDuelAccept(request, env);
  if (POST && p === '/api/duel-cancel') return handleDuelCancel(request, env);
  if (GET && p === '/api/duels') return handleDuelList(request, env);
  if (GET && p === '/api/my-submissions') return handleMySubmissions(request, env);
  if (GET && p === '/api/me') return handleMe(request, env);
  if (GET && p === '/api/my-predictions') return handleMyPredictions(request, env);
  if (GET && p === '/api/leaderboard') return handleLeaderboard(request, env);
  if (GET && p === '/api/achievements') return handleAchievements(request, env);
  if (GET && p === '/api/achievement-board') return handleAchievementBoard(request, env);
  if (GET && p === '/api/session') return handleSession(request, env);

  // -------- 登录认证（邮箱+密码） --------
  if (POST && p === '/api/register') return handleRegister(request, env);
  if (POST && p === '/api/login') return handleLogin(request, env);

  // -------- 预测下单 --------
  if (POST && p === '/api/predict') return handlePredict(request, env);
  if (POST && p === '/api/event-predict') return handleEventPredict(request, env);
  if (POST && p === '/api/daily-grant') return handleDailyGrant(request, env);

  // -------- 管理员接口 --------
  if (p.startsWith('/api/admin/')) {
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${env.ADMIN_TOKEN}`) {
      return new Response(JSON.stringify({ success: false, error: '无权限' }), { status: 401, headers: JSON_HEADERS });
    }
    // 同步所有未开赛比赛 + 自动生成赔率
    if (POST && p === '/api/admin/sync-matches') {
      const summary = await syncMatches(env);
      return new Response(JSON.stringify(summary), { headers: JSON_HEADERS });
    }
    // 初始化/刷新赛事级市场（夺冠、金靴）
    if (POST && p === '/api/admin/seed-events') {
      const summary = await seedEventMarkets(env);
      return new Response(JSON.stringify(summary), { headers: JSON_HEADERS });
    }
    // 手动触发结算
    if (POST && p === '/api/admin/run-settlement') {
      const summary = await runSettlement(env);
      return new Response(JSON.stringify(summary), { headers: JSON_HEADERS });
    }
    // 一键生成测试比赛（内测用，不依赖外部api）
    if (POST && p === '/api/admin/seed-test-matches') {
      return handleSeedTestMatches(request, env);
    }
    // 只更新国旗（不碰比赛和下注）
    if (POST && p === '/api/admin/update-flags') {
      return handleUpdateFlags(request, env);
    }
    // 录入真实场次（来自截图）
    if (POST && p === '/api/admin/seed-real-matches') {
      return handleSeedRealMatches(request, env);
    }
    // 手动结算测试比赛（指定比分）
    if (POST && p === '/api/admin/settle-test') {
      return handleSettleTest(request, env);
    }
    // 管理员重置用户密码（朋友忘密码时用）
    if (POST && p === '/api/admin/reset-password') {
      return handleAdminResetPassword(request, env);
    }
    // 后台：列出所有比赛
    if (POST && p === '/api/admin/list-matches') {
      return handleAdminListMatches(request, env);
    }
    // 后台：添加单场比赛
    if (POST && p === '/api/admin/add-match') {
      return handleAddMatch(request, env);
    }
    // 后台：给已有比赛补比分玩法
    if (POST && p === '/api/admin/patch-scores') {
      const { matchId } = await request.json();
      const db = env.DB;
      const { insertExactScoreTiers, loadPredictionTypeIds } = await import('./score-markets.js');
      const ptypes = await loadPredictionTypeIds(db);
      if (!ptypes['exact_score']) return new Response(JSON.stringify({success:false,error:'exact_score题型不存在'}),{headers:{'Content-Type':'application/json'}});
      await insertExactScoreTiers(db, matchId, ptypes['exact_score']);
      return new Response(JSON.stringify({success:true,message:'已补比分'}),{headers:{'Content-Type':'application/json'}});
    }
    // 夺冠/金靴市场：录入
    if (POST && p === '/api/admin/seed-champion-scorer') {
      return handleSeedChampionScorer(request, env);
    }
    // 夺冠/金靴市场：列出（含选项，供编辑）
    if (POST && p === '/api/admin/list-event-markets') {
      return handleListEventMarkets(request, env);
    }
    // 夺冠/金靴市场：编辑赔率/截止时间
    if (POST && p === '/api/admin/edit-event-market') {
      return handleEditEventMarket(request, env);
    }
    // 夺冠/金靴市场：结算
    if (POST && p === '/api/admin/settle-event-market') {
      return handleSettleEventMarket(request, env);
    }
    // 用户管理：列出 / 删除
    if (POST && p === '/api/admin/list-users') {
      return handleListUsers(request, env);
    }
    if (POST && p === '/api/admin/delete-user') {
      return handleDeleteUser(request, env);
    }
    if (POST && p === '/api/admin/grant-points') {
      return handleGrantPoints(request, env);
    }
    if (POST && p === '/api/admin/list-pending') {
      return handleListPending(request, env);
    }
    if (POST && p === '/api/admin/review-event') {
      return handleReviewEvent(request, env);
    }
    if (POST && p === '/api/admin/add-score-market') {
      return handleAddScoreMarket(request, env);
    }
    if (POST && p === '/api/admin/add-score-all') {
      return handleAddScoreAll(request, env);
    }
    if (POST && p === '/api/admin/settle-duels') {
      return handleSettleDuels(request, env);
    }
  }

  return new Response('Not found', { status: 404, headers: JSON_HEADERS });
}
