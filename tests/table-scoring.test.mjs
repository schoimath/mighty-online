import test from 'node:test';
import assert from 'node:assert/strict';
import {settlementDetails, settlements} from '../table-scoring.js';

const round = (points, target = 15, friend = 1) => ({points, target, won:points >= target, declarer:0, friend});

test('a made contract earns a bid bonus and overtricks, a missed contract loses its shortfall', () => {
  assert.deepEqual(settlements(round(17), 'H'), [12, 6, -6, -6, -6]);
  assert.deepEqual(settlements(round(14), 'H'), [-2, -1, 1, 1, 1]);
  assert.deepEqual(settlements(round(11), 'H'), [-8, -4, 4, 4, 4]);
  assert.deepEqual(settlements(round(10), 'H'), [-20, -10, 10, 10, 10]);
  assert.equal(settlementDetails(round(17, 16), 'H').base, 7);
  assert.equal(settlementDetails(round(15, 15), 'H').base, 4);
  assert.deepEqual(settlements(round(13, 13), 'H'), [0, 0, 0, 0, 0]);
});

test('run or backrun, no trump and no friend each double the stake exactly once', () => {
  assert.deepEqual(settlements(round(20), 'H'), [36, 18, -18, -18, -18]);
  assert.deepEqual(settlements(round(20, 15, null), 'N'), [288, -72, -72, -72, -72]);
  assert.deepEqual(settlements(round(10, 15, null), 'N'), [-160, 40, 40, 40, 40]);
  for (let target = 13; target <= 20; target++) for (let points = 0; points <= 20; points++) {
    for (const friend of [1, null]) for (const suit of ['H','N']) {
      assert.equal(settlements(round(points,target,friend),suit).reduce((a,b) => a+b, 0), 0);
    }
  }
});
