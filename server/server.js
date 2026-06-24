// ============================================================
// Node.js 服务器入口（部署在腾讯云）
// 复用 worker/ 目录里的全部业务逻辑（route 函数），
// 只是把运行环境从 Cloudflare Workers 换成 Node.js http 服务。
//
// 启动: node server/server.js
// 访问: http://你的服务器IP:8080
// ============================================================

import http from 'http';
import { createDB } from './d1-adapter.js';
import { route } from '../worker/index.js';
import { runSettlement } from '../worker/settle.js';

const PORT = process.env.PORT || 8080;
const DB_FILE = process.env.DB_FILE || './worldcup.db';

// 构造 env 对象，模拟 Cloudflare 的 env（业务代码通过 env.DB / env.SPORTS_API_KEY 访问）
const env = {
  DB: createDB(DB_FILE),
  SPORTS_API_KEY: process.env.SPORTS_API_KEY || '',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'changeme',
};

// 把 Node 的 http 请求转成 Web 标准 Request，喂给 route，再把 Response 写回 Node
const server = http.createServer(async (req, res) => {
  try {
    // 读取请求体
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : body,
    });

    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    const response = await route(request, env, new URL(url));

    // 把 Response 写回 Node res
    const respBody = await response.text();
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    headers['Access-Control-Allow-Origin'] = '*';
    res.writeHead(response.status || 200, headers);
    res.end(respBody);
  } catch (err) {
    console.error('请求处理出错:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: '服务器内部错误: ' + String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`先知局服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`数据库文件: ${DB_FILE}`);
});

// 定时结算（替代 Cloudflare cron）：每2小时跑一次
setInterval(async () => {
  try {
    const summary = await runSettlement(env);
    console.log('[定时结算]', new Date().toISOString(), JSON.stringify(summary));
  } catch (e) {
    console.error('[定时结算] 出错:', e);
  }
}, 2 * 3600 * 1000);
