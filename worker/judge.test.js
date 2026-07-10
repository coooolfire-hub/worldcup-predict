import assert from 'node:assert/strict';
import test from 'node:test';

import { judgeMatchOutcome } from './judge.js';

test('exact_score resolves to the final score key', () => {
  assert.equal(judgeMatchOutcome('exact_score', 2, 1), '2-1');
});
