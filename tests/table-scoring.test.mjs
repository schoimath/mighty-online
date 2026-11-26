import test from 'node:test';
import assert from 'node:assert/strict';
import {settlementDetails, settlements} from '../table-scoring.js';
import {handOutcome, scoreTable} from '../score-ui.js';

const round = (points, target = 15, friend = 1) => ({points, target, won:points >= target, declarer:0, friend});

test('each seat sees its own victory or defeat even when everyone settles zero points', () => {
  for (const [seat,role] of [[0,'주공'],[1,'프렌드'],[4,'야당']]) {
    for (const result of [round(13,13),round(14,15),round(17,15)]) {
      const won = (seat === result.declarer || seat === result.friend) === result.won;
      assert.deepEqual(handOutcome(result, seat),{title:won ? '이번 판 승리' : '이번 판 패배',role,won});
    }
  }
  assert.equal(handOutcome(round(12,14,null),1).title,'이번 판 승리');
  assert.deepEqual(handOutcome(round(12,14,null),-1),{title:'야당 승리',role:null,won:null});
  assert.deepEqual(handOutcome(round(15,14,null),-1),{title:'여당 승리',role:null,won:null});
});

test('the result scoreboard marks the original player when an AI has taken the same seat', () => {
  const board = {rounds:2,panelMemberIds:['original'],members:[
    {id:'replacement',name:'교체 AI',seat:0,total:0,lastDelta:null},
    {id:'original',name:'원래 참가자',seat:null,total:8,lastDelta:8}
  ]};
  const table=scoreTable(board,0);
  assert.match(table, /원래 참가자 <small>나<\/small>/);
  assert.doesNotMatch(table, /교체 AI <small>나<\/small>/);
  assert.doesNotMatch(scoreTable(board,-1), /standing-mine/);
});

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
