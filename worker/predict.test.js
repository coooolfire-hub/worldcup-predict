import assert from 'node:assert/strict';
import test from 'node:test';

import { handlePredict } from './predict.js';

class FakeStmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async first() {
    if (this.sql.includes('FROM matches')) return this.db.match;
    if (this.sql.includes('FROM prediction_types')) return this.db.predictionType;
    if (this.sql.includes('FROM match_outcome_tiers')) return this.db.tier;
    if (this.sql.includes('FROM users')) return this.db.user;
    return null;
  }

  async run() {
    this.db.runs.push({ sql: this.sql, args: this.args });
    return { meta: { last_row_id: 1 } };
  }
}

class FakeDb {
  constructor() {
    this.match = { id: 1, kickoff_time: Math.floor(Date.now() / 1000) + 3600 };
    this.predictionType = { id: 7, code: 'match_result' };
    this.tier = { multiplier: 2.4, stake_cap: 10000 };
    this.user = { id: 9, points_balance: 25000 };
    this.batchCalls = [];
    this.runs = [];
  }

  prepare(sql) {
    return new FakeStmt(this, sql);
  }

  async batch(stmts) {
    this.batchCalls.push(stmts);
    return [{ meta: {} }, { meta: { last_row_id: 42 } }];
  }
}

test('match prediction allows stakes above the old 10000 point cap when balance is enough', async () => {
  const db = new FakeDb();
  const request = new Request('https://example.test/api/predict', {
    method: 'POST',
    body: JSON.stringify({
      userId: 9,
      matchId: 1,
      predictionTypeCode: 'match_result',
      outcomeKey: 'home_win',
      pointsStaked: 15000,
    }),
  });

  const response = await handlePredict(request, { DB: db });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.predictionId, 42);
  assert.equal(db.batchCalls.length, 1);
});
