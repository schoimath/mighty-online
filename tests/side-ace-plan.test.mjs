import test from 'node:test';
import assert from 'node:assert/strict';
import {botDecision, botObservation, DECK, policyPlay} from '../engine.js';
import {rngFor} from '../lab/game.js';
import {decideTableTurn} from '../lab/table-agents.js';
import {clubPolicies} from './table-policy-models.mjs';
import {applyAction, createGame} from '../table-deal.js';
import {preferSideAcePlan} from '../table-side-ace.js';

function declareAndBury(state, suit) {
  const step = action => applyAction(state, state.turn, action);
  step({type:'bid', suit, points:16});
  for (let i = 0; i < 4; i++) step({type:'pass'});
  step(botDecision(botObservation(state, 0), policyPlay));
  return step;
}

test('each table model calls a reachable side ace and leads its ordinary three', () => {
  const state = createGame({random:rngFor(234), rules:{allowFirstJokerCall:true}});
  const step = declareAndBury(state, 'H');
  const callView = botObservation(state, 0);
  assert.equal(botDecision(callView, policyPlay).card, 'DA');
  assert.ok(callView.hand.every(card => card[0] !== 'D'));
  const call = {type:'friend', kind:'card', card:'CA'};
  for (const id of clubPolicies) {
    assert.deepEqual(decideTableTurn({modelId:id, view:callView, seed:97}).action, call, id);
  }
  step(call);
  const view = botObservation(state, 0), original = structuredClone(view);
  assert.ok(view.choices.plays.some(move => move.card === 'C3' && move.jokerCall));
  for (const id of clubPolicies) {
    assert.deepEqual(decideTableTurn({modelId:id, view, seed:97}).action, {type:'play',card:'C3'}, id);
  }
  assert.deepEqual(view, original);
  step({type:'play', card:'C3'});
});

test('the highest outside trump is a reachable fallback when side aces are dead ends', () => {
  const state = createGame({random:rngFor(308)});
  const step = declareAndBury(state, 'S');
  const callView = botObservation(state, 0);
  const oldCall = botDecision(callView, policyPlay);
  assert.equal(oldCall.card, 'CA');
  assert.ok(callView.hand.every(card => card[0] !== 'C'));
  const call = preferSideAcePlan(callView, oldCall);
  assert.deepEqual(call, {type:'friend',kind:'card',card:'SJ'});
  step(call);
  const opening = {type:'play',card:'HA'};
  assert.deepEqual(preferSideAcePlan(botObservation(state, 0), opening), opening);
  step(opening);
  while (state.trickNo === 1) step(botDecision(botObservation(state, state.turn), policyPlay));
  const view = botObservation(state, state.turn);
  assert.equal(view.turn, 0);
  assert.equal(view.friendKnown, false);
  const modelChoice = {type:'play',card:'SA'};
  assert.deepEqual(preferSideAcePlan(view, modelChoice), {type:'play',card:'S2'});
  // A replacement host missing a trick must not infer that a trump is master.
  assert.equal(preferSideAcePlan({...view, playedTricks:[]}, modelChoice), modelChoice);
  assert.equal(preferSideAcePlan({...view, friendKnown:true}, modelChoice), modelChoice);
  step({type:'play',card:'S2'});
});

test('a proven solo sweep with all three controls keeps the no-friend multiplier', () => {
  const state = createGame({random:rngFor(234)});
  declareAndBury(state, 'H');
  const hand = ['SA','HA','HK','HQ','HJ','H10','H9','H8','H7','JK'];
  const discarded = ['C2','D2','S2'];
  state.hands = [hand, ...Array.from({length:4}, () => [])];
  DECK.filter(card => !hand.includes(card) && !discarded.includes(card))
    .forEach((card,i) => state.hands[1 + i % 4].push(card));
  state.discarded = discarded;
  const view = botObservation(state, 0);
  assert.deepEqual(preferSideAcePlan(view, {type:'friend',kind:'card',card:'CA'}), {type:'friend',kind:'none'});
});

test('preserve the model strategy for contracts outside the three-control plan', () => {
  const state = createGame({random:rngFor(234)});
  declareAndBury(state, 'H');
  const view = botObservation(state, 0);
  const choice = {type:'friend',kind:'card',card:'DA'};
  for (const control of ['SA','HA','JK']) {
    assert.equal(preferSideAcePlan({...view, hand:view.hand.filter(card => card !== control)}, choice), choice);
  }
  assert.equal(preferSideAcePlan({...view, bid:{...view.bid, suit:'N'}}, choice), choice);
});
