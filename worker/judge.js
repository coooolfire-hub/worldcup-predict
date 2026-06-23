// ============================================================
// 结果判定逻辑
// 输入最终比分（或赛事级数据），输出每种题型的真实 outcome_key，
// 拿去跟 predictions 表里用户押的 outcome_key 做比较。
//
// 题型范围（按需求收敛）：
//   单场市场: match_result（胜平负）、both_teams_score（双方是否都进球）
//   赛事级市场: champion（夺冠）、top_scorer（金靴/进球最多）
//     —— 赛事级市场不靠单场比分判定，用专门的赛事结算流程，见 settle.js
// ============================================================

// 单场比赛级判定：输入最终比分
export function judgeMatchOutcome(predictionTypeCode, homeScore, awayScore) {
  switch (predictionTypeCode) {
    case 'match_result':
      if (homeScore > awayScore) return 'home_win';
      if (homeScore < awayScore) return 'away_win';
      return 'draw';

    case 'both_teams_score':
      return homeScore > 0 && awayScore > 0 ? 'yes' : 'no';

    default:
      throw new Error(`未知的单场题型: ${predictionTypeCode}`);
  }
}

// 赛事级判定：champion / top_scorer
// 这些市场的 outcome_key 就是"队名缩写"或"球员id"，
// 结算时直接拿赛事最终结果的 key 去比对，不需要比分计算。
// winnerKey 由 settle.js 从赛事数据里取出后传入。
export function judgeTournamentOutcome(predictionTypeCode, winnerKey) {
  // champion 和 top_scorer 都是"谁是赢家"型，判定就是 key 相等
  return winnerKey;
}

// 哪些题型属于"单场比赛级"，哪些属于"整届赛事级"
export const MATCH_LEVEL_TYPES = ['match_result', 'both_teams_score'];
export const TOURNAMENT_LEVEL_TYPES = ['champion', 'top_scorer'];
