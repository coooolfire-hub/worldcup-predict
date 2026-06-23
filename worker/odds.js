// ============================================================
// 赔率自动生成算法
// 设计原则（对应需求）：
//   - 开赛前一次性算好，锁定后不变（不实时浮动，不跟押注资金走）
//   - 用"隐含概率 → 倍率"的反推逻辑，类似博彩/Polymarket的定价直觉
//   - 有球队排名/战力数据就用来调整概率，没有就退化成"主场略占优"的基础分布
//
// 核心公式：
//   倍率 = (1 / 概率) × (1 - 平台让利系数)
//   平台让利系数 PAYOUT_MARGIN：让所有结果的隐含概率之和略大于100%，
//   这是博彩的常规做法（vig/抽水），保证长期发放的点数总量可控。
//   注意：这里"让利"不涉及真钱，只是控制虚拟积分的通胀速度，
//   避免赔率过高导致积分发放失控。
// ============================================================

const PAYOUT_MARGIN = 0.08; // 8% 抽水，倍率会比理论公平值略低
const MIN_MULTIPLIER = 1.15; // 倍率下限，避免大热门赔率太低没意思
const MAX_MULTIPLIER = 15.0; // 倍率上限，避免极端冷门赔率虚高

/**
 * 根据胜平负三方概率生成倍率
 * @param {{home:number, draw:number, away:number}} probs 三个概率，会自动归一化
 * @returns {{home_win:number, draw:number, away_win:number}} 三个倍率
 */
export function multipliersFromProbs(probs) {
  // 归一化，确保三者加起来=1
  const sum = probs.home + probs.draw + probs.away;
  const norm = { home: probs.home / sum, draw: probs.draw / sum, away: probs.away / sum };

  const toMult = (p) => {
    const raw = (1 / p) * (1 - PAYOUT_MARGIN);
    return Math.round(clamp(raw, MIN_MULTIPLIER, MAX_MULTIPLIER) * 10) / 10; // 保留1位小数
  };

  return {
    home_win: toMult(norm.home),
    draw: toMult(norm.draw),
    away_win: toMult(norm.away),
  };
}

/**
 * 从球队FIFA排名/战力值估算胜平负概率
 * api-sports.io 的 standings/teams 接口能拿到球队信息，
 * 但世界杯小组赛前未必有完整排名，所以做成"有数据就用，没有就退化"。
 *
 * @param {number|null} homeRank 主队排名（数字越小越强），可为null
 * @param {number|null} awayRank 客队排名，可为null
 * @returns {{home:number, draw:number, away:number}}
 */
export function estimateProbs(homeRank, awayRank) {
  // 没有排名数据时：用一个温和的基础分布（主队微弱占优 + 平局有一定概率）
  if (homeRank == null || awayRank == null) {
    return { home: 0.40, draw: 0.28, away: 0.32 };
  }

  // 有排名时：用排名差转换成实力差。
  // 用 Elo 风格的逻辑：排名差越大，强队胜率越高。
  // 把"排名"近似成 Elo 分（排名1≈2000分，每差1名扣几分），算期望胜率。
  const homeElo = rankToElo(homeRank);
  const awayElo = rankToElo(awayRank);
  const diff = homeElo - awayElo + 60; // +60 是主场优势加成

  // Elo 期望胜率公式
  const expHome = 1 / (1 + Math.pow(10, -diff / 400));
  // expHome 是"不考虑平局时主队赢的期望"，足球需要拆出平局
  // 经验做法：平局概率随两队实力接近而升高
  const closeness = 1 - Math.abs(expHome - 0.5) * 2; // 0~1，越接近50:50越大
  const drawProb = 0.22 + 0.12 * closeness; // 平局概率 22%~34%

  const remaining = 1 - drawProb;
  const homeProb = remaining * expHome;
  const awayProb = remaining * (1 - expHome);

  return { home: homeProb, draw: drawProb, away: awayProb };
}

// 把FIFA排名粗略映射成Elo分，仅用于赔率估算，不需要很精确
function rankToElo(rank) {
  // 排名1 ≈ 2050，排名越靠后分越低，衰减放缓
  return 2050 - Math.log2(rank + 1) * 130;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 二元市场（如"双方是否都进球"）的倍率生成
 * @param {number} yesProb "是"的概率
 * @returns {{yes:number, no:number}}
 */
export function binaryMultipliers(yesProb) {
  const p = clamp(yesProb, 0.05, 0.95);
  const toMult = (prob) => {
    const raw = (1 / prob) * (1 - PAYOUT_MARGIN);
    return Math.round(clamp(raw, MIN_MULTIPLIER, MAX_MULTIPLIER) * 10) / 10;
  };
  return { yes: toMult(p), no: toMult(1 - p) };
}

/**
 * 夺冠/金靴这类多选项市场的倍率生成
 * @param {Array<{key:string, prob:number}>} options 每个选项及其概率
 * @returns {Array<{key:string, multiplier:number}>}
 */
export function multiOptionMultipliers(options) {
  const sum = options.reduce((s, o) => s + o.prob, 0);
  return options.map((o) => {
    const p = o.prob / sum;
    const raw = (1 / p) * (1 - PAYOUT_MARGIN);
    return { key: o.key, multiplier: Math.round(clamp(raw, MIN_MULTIPLIER, MAX_MULTIPLIER) * 10) / 10 };
  });
}
