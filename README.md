# 先知局 · 世界杯预测社区

积分制预测平台，参考 Polymarket 玩法。积分仅用于娱乐排名，不可兑换、不可提现。
技术栈：Cloudflare Workers + D1（与 yongai.online 同一套基建）。

## 项目结构

```
worldcup-predict/
├── worker/          后端（Cloudflare Workers）
│   ├── index.js       路由入口 + cron
│   ├── sports-api.js   api-sports.io 数据源适配
│   ├── sync.js         比赛同步 + 赔率自动生成
│   ├── odds.js         赔率算法（隐含概率反推倍率）
│   ├── settle.js       自动结算（判定结果、发积分、连胜）
│   ├── judge.js        比分 → 结果判定
│   ├── predict.js      预测下单（单场 + 赛事级）
│   ├── auth.js         邮箱密码登录（PBKDF2）
│   ├── queries.js      市场/用户/赛事市场查询
│   ├── leaderboard.js  排行榜
│   ├── daily-grant.js  每日积分发放
│   ├── seed-events.js  夺冠/金靴市场初始化
│   └── admin.js        管理员手动接口（备用）
├── schema/          数据库
│   ├── schema.sql            主表
│   ├── seed.sql              题型/成就种子
│   ├── auth-schema.sql       登录相关表
│   └── event-markets-schema.sql  夺冠/金靴市场表
├── frontend/
│   └── app.html     单文件前端（响应式，手机+电脑）
├── docs/            早期设计预览（参考用）
├── wrangler.toml
└── package.json
```

## 快速开始

```bash
# 1. 安装 wrangler
npm install

# 2. 创建数据库，把返回的 database_id 填进 wrangler.toml
npx wrangler d1 create worldcup-predict-db

# 3. 初始化所有表
npm run db:init

# 4. 设置密钥（不要写进代码）
npx wrangler secret put SPORTS_API_KEY    # api-sports.io 的 key
npx wrangler secret put ADMIN_TOKEN       # 自定义一个强密码

# 5. 部署
npm run deploy
```

## 上线前必做

1. **核实世界杯 league id**：调 `GET /leagues?search=World Cup` 查到真实 id，
   填进 `worker/sports-api.js` 的 `WORLD_CUP.leagueId`（现在是占位符 1）。
2. **前端 API 地址**：把 `frontend/app.html` 里 `CONFIG.API_BASE` 改成你的 worker 地址。

## 日常运营

```bash
# 同步比赛 + 自动生成赔率（赛程更新后跑）
curl -X POST https://你的worker地址/api/admin/sync-matches -H "Authorization: Bearer $ADMIN_TOKEN"

# 初始化夺冠/金靴市场（赛事前跑一次）
curl -X POST https://你的worker地址/api/admin/seed-events -H "Authorization: Bearer $ADMIN_TOKEN"
```

结算由 cron 自动跑（wrangler.toml 中已设每2小时）。

## 合规说明

- 积分不可兑换/转让/提现，赔率开赛前锁定不实时浮动，单局上限 10000
- 内测阶段不实名、不备案，守住"不对外公开推广"边界
- 正式对外运营前需补：实名、ICP 备案、内容审核，并请律师审核积分规则
