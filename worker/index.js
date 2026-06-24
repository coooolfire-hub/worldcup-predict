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
import { handleMarkets, handleMe, handleMyPredictions, handleEventMarkets } from './queries.js';
import { handleRegister, handleLogin, handleSession } from './auth.js';
import { handleEventPredict } from './predict.js';
import { syncMatches } from './sync.js';
import { seedEventMarkets } from './seed-events.js';
import { handleSeedTestMatches, handleSettleTest } from './test-seed.js';
import { handleSeedRealMatches } from './real-seed.js';
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

  // -------- 读接口 --------
  if (GET && p === '/api/markets') return handleMarkets(request, env);
  if (GET && p === '/api/event-markets') return handleEventMarkets(request, env);
  if (GET && p === '/api/me') return handleMe(request, env);
  if (GET && p === '/api/my-predictions') return handleMyPredictions(request, env);
  if (GET && p === '/api/leaderboard') return handleLeaderboard(request, env);
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
    // 录入真实场次（来自截图）
    if (POST && p === '/api/admin/seed-real-matches') {
      return handleSeedRealMatches(request, env);
    }
    // 手动结算测试比赛（指定比分）
    if (POST && p === '/api/admin/settle-test') {
      return handleSettleTest(request, env);
    }
  }

  return new Response('Not found', { status: 404, headers: JSON_HEADERS });
}
