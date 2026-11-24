import test from 'node:test';
import assert from 'node:assert/strict';
import {settlementDetails, settlements} from '../table-scoring.js';

const round = (points, target = 15, friend = 1) => ({points, target, won:points >= target, declarer:0, friend});

test('the final contract sets the stake and ten opposition points trigger a backrun', () => {
  assert.deepEqual(settlements(round(17), 'H'), [10, 5, -5, -5, -5]);
  assert.deepEqual(settlements(round(14), 'H'), [-10, -5, 5, 5, 5]);
  assert.deepEqual(settlements(round(11), 'H'), [-10, -5, 5, 5, 5]);
  assert.deepEqual(settlements(round(10), 'H'), [-20, -10, 10, 10, 10]);
  assert.equal(settlementDetails(round(17, 16), 'H').base, 6);
});

test('run or backrun, no trump and no friend each double the stake exactly once', () => {
  assert.deepEqual(settlements(round(20), 'H'), [20, 10, -10, -10, -10]);
  assert.deepEqual(settlements(round(20, 15, null), 'N'), [160, -40, -40, -40, -40]);
  assert.deepEqual(settlements(round(10, 15, null), 'N'), [-160, 40, 40, 40, 40]);
  for (let target = 13; target <= 20; target++) for (let points = 0; points <= 20; points++) {
    for (const friend of [1, null]) for (const suit of ['H','N']) {
      assert.equal(settlements(round(points,target,friend),suit).reduce((a,b) => a+b, 0), 0);
    }
  }
});
