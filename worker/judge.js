import { EXACT_SCORE_TYPE_CODE, exactScoreOutcome } from './score-markets.js';

export function judgeMatchOutcome(predictionTypeCode, homeScore, awayScore) {
  switch (predictionTypeCode) {
    case 'match_result':
      if (homeScore > awayScore) return 'home_win';
      if (homeScore < awayScore) return 'away_win';
      return 'draw';

    case 'both_teams_score':
      return homeScore > 0 && awayScore > 0 ? 'yes' : 'no';

    case EXACT_SCORE_TYPE_CODE:
      return exactScoreOutcome(homeScore, awayScore);

    default:
      throw new Error(`未知的单场题型: ${predictionTypeCode}`);
  }
}

export function judgeTournamentOutcome(predictionTypeCode, winnerKey) {
  return winnerKey;
}

export const MATCH_LEVEL_TYPES = ['match_result', 'both_teams_score', EXACT_SCORE_TYPE_CODE];
export const TOURNAMENT_LEVEL_TYPES = ['champion', 'top_scorer'];
