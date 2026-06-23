// ============================================================
// 体育数据源适配层 —— api-sports.io (v3.football.api-sports.io)
//
// 认证方式：请求头 'x-apisports-key': <你的key>
// key 通过 wrangler secret 设置为 SPORTS_API_KEY，不写进代码。
//
// 上线前必做：核实 World Cup 2026 的真实 league id 和 season。
//   可调 GET /leagues?search=World Cup 查到 league id，填到下面 WORLD_CUP。
// ============================================================

const BASE = 'https://v3.football.api-sports.io';

// ⚠️ 占位：上线前用 /leagues?search=World Cup 查到真实值替换
const WORLD_CUP = {
  leagueId: 1,   // World Cup 的 league id（占位，必须核实）
  season: 2026,
};

function headers(apiKey) {
  return { 'x-apisports-key': apiKey };
}

async function apiGet(apiKey, path) {
  const resp = await fetch(BASE + path, { headers: headers(apiKey) });
  if (!resp.ok) {
    throw new Error(`api-sports 请求失败 ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  // api-sports 的错误信息放在 data.errors 里，HTTP 仍是200，要单独检查
  if (data.errors && (Array.isArray(data.errors) ? data.errors.length : Object.keys(data.errors).length)) {
    throw new Error(`api-sports 业务错误: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

// 状态码映射
function mapStatus(short) {
  const FINISHED = ['FT', 'AET', 'PEN'];
  const LIVE = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'];
  const CANCELLED = ['CANC', 'ABD', 'AWD', 'WO', 'PST'];
  if (FINISHED.includes(short)) return 'finished';
  if (LIVE.includes(short)) return 'live';
  if (CANCELLED.includes(short)) return 'cancelled';
  return 'scheduled';
}

// ---------- 拉取赛程（同步所有未开赛比赛用） ----------
export async function fetchAllFixtures(apiKey) {
  const data = await apiGet(
    apiKey,
    `/fixtures?league=${WORLD_CUP.leagueId}&season=${WORLD_CUP.season}`
  );
  return data.response.map((f) => ({
    externalMatchId: String(f.fixture.id),
    stage: f.league.round || '小组赛',
    homeTeam: f.teams.home.name,
    awayTeam: f.teams.away.name,
    homeTeamId: f.teams.home.id,
    awayTeamId: f.teams.away.id,
    kickoffTime: Math.floor(new Date(f.fixture.date).getTime() / 1000),
    status: mapStatus(f.fixture.status.short),
    homeScore: f.goals.home,
    awayScore: f.goals.away,
  }));
}

// ---------- 拉取单场最新状态（结算时二次确认比分） ----------
export async function fetchSingleMatch(apiKey, externalMatchId) {
  const data = await apiGet(apiKey, `/fixtures?id=${externalMatchId}`);
  if (!data.response || data.response.length === 0) return null;
  const f = data.response[0];
  return {
    externalMatchId: String(f.fixture.id),
    status: mapStatus(f.fixture.status.short),
    homeScore: f.goals.home,
    awayScore: f.goals.away,
  };
}

// ---------- 拉取球队FIFA排名（赔率算法用，拿不到就返回空map） ----------
// 世界杯赛事的 standings 在小组赛阶段可能没有，所以容错：失败就返回 {}
export async function fetchTeamRankings(apiKey) {
  try {
    const data = await apiGet(
      apiKey,
      `/standings?league=${WORLD_CUP.leagueId}&season=${WORLD_CUP.season}`
    );
    const map = {};
    // standings 是按小组分的二维数组
    for (const league of data.response) {
      for (const group of league.league.standings) {
        for (const row of group) {
          map[row.team.id] = row.rank; // 这里是组内排名，仅作弱参考
        }
      }
    }
    return map;
  } catch (e) {
    console.log('排名数据不可用，赔率将使用基础分布:', String(e));
    return {};
  }
}

// ---------- 拉取射手榜（金靴市场用，可开关） ----------
// 免费套餐可能不支持此接口；调用失败时上层应跳过金靴市场，不报错中断
export async function fetchTopScorers(apiKey) {
  const data = await apiGet(
    apiKey,
    `/players/topscorers?league=${WORLD_CUP.leagueId}&season=${WORLD_CUP.season}`
  );
  return data.response.map((p) => ({
    playerId: String(p.player.id),
    playerName: p.player.name,
    goals: p.statistics[0]?.goals?.total || 0,
  }));
}

// ---------- 判断整届赛事是否结束 + 取冠军 ----------
// 通过决赛（round 含 "Final"）的结果判断
export async function fetchTournamentResult(apiKey) {
  const data = await apiGet(
    apiKey,
    `/fixtures?league=${WORLD_CUP.leagueId}&season=${WORLD_CUP.season}`
  );
  const fixtures = data.response;
  // 找决赛（排除三四名决赛 "3rd Place"）
  const final = fixtures.find(
    (f) =>
      /final/i.test(f.league.round) &&
      !/3rd|third|place/i.test(f.league.round)
  );
  if (!final || mapStatus(final.fixture.status.short) !== 'finished') {
    return { finished: false };
  }
  const championId =
    final.goals.home > final.goals.away ? final.teams.home.id : final.teams.away.id;
  return {
    finished: true,
    championTeamId: String(championId),
  };
}

export { WORLD_CUP };
