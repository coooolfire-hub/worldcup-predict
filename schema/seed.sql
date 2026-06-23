-- 题型基础数据（收敛后：单场只保留胜平负 + 双方进球）
INSERT OR IGNORE INTO prediction_types (code, name, description) VALUES
  ('match_result', '比赛结果预测', '预测90分钟常规时间内的胜平负'),
  ('both_teams_score', '双方能否都进球', '预测两队是否都能进球');

-- 成就/称号
INSERT OR IGNORE INTO achievements (code, name, description) VALUES
  ('world_cup_oracle', '世界杯先知', '世界杯期间预测准确率达到指定门槛'),
  ('streak_5', '五连胜', '连续5次预测命中'),
  ('streak_10', '十连胜', '连续10次预测命中'),
  ('streak_20', '二十连胜', '连续20次预测命中，传奇级');
