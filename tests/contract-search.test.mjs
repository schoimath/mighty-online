import test from 'node:test';
import assert from 'node:assert/strict';
import {botDecision, botObservation} from '../engine.js';
import {applyAction, createGame} from '../table-deal.js';
import {contractSearchAction} from '../lab/contract-search.js';
import {rngFor} from '../lab/game.js';

test('post-kitty contract search uses the declarer observation and produces an executable revision', () => {
  const state = createGame({random:rngFor(1)});
  applyAction(state, 0, botDecision(botObservation(state,0)));
  for (let i=1; i<5; i++) applyAction(state,i,{type:'pass'});
  const other = structuredClone(state);
  [other.hands[1][0], other.hands[3][0]] = [other.hands[3][0], other.hands[1][0]];
  const view = botObservation(state,0), before = structuredClone(view);
  const action = contractSearchAction(view,rngFor(3401));
  assert.deepEqual(action,contractSearchAction(botObservation(other,0),rngFor(3401)));
  assert.deepEqual(view,before);
  assert.ok(action.contract.points > state.bid.points);
  applyAction(state,0,action);
  assert.equal(state.phase,'friend');
  assert.deepEqual(state.discarded,action.cards);
});
