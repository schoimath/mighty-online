import assert from 'node:assert/strict';
import test from 'node:test';
import {baselinePlay, botObservation} from '../engine.js';
import {rngFor} from '../lab/game.js';
import {decideTableTurn, MODEL_CATALOG} from '../lab/table-agents.js';
import {applyAction, createGame} from '../table-deal.js';
import {protectCalledJoker} from '../table-tactics.js';

function reachLead(seed, trump, trickNo, allowFirstJokerCall) {
  const random = rngFor(seed);
  const round = createGame({random, rules:{allowFirstJokerCall}});
  const step = action => applyAction(round, round.turn, action, random);
  const caller = trump === 'C' ? 'S3' : 'C3';
  step({type:'bid', points:14, suit:trump});
  for (let i = 0; i < 4; i++) step({type:'pass'});
  const cards = [...round.hands[0]].reverse().filter(card => card !== caller).slice(0,3);
  step({type:'discard', cards});
  step({type:'friend', kind:'card', card:'JK'});
  while (round.trickNo < trickNo) step({type:'play', ...baselinePlay(botObservation(round, round.turn))});
  assert.equal(round.turn, round.declarer);
  assert.equal(round.friendKnown, false);
  assert.ok(round.friend !== null && round.friend !== round.declarer);
  return {round, caller, view:botObservation(round, round.turn)};
}

test('all table policies keep a Joker friend active and retain the plain caller card', () => {
  // Actual deals where at least one original model disabled its partner's Joker.
  for (const [seed, trump, trick, openingCalls] of [
    [290016, 'H', 2, false], [290070, 'C', 2, true], [290575, 'N', 1, true]
  ]) {
    const {round, caller, view} = reachLead(seed, trump, trick, openingCalls);
    const original = structuredClone(view);
    const guarded = protectCalledJoker(view);
    assert.deepEqual(guarded.choices.plays, view.choices.plays.filter(move => !move.jokerCall));
    assert.ok(guarded.choices.plays.some(move => move.card === caller));
    for (const {id:modelId} of MODEL_CATALOG) {
      const {action} = decideTableTurn({modelId, view, seed});
      assert.ok(!action.jokerCall, `${modelId}: ${trump} on trick ${trick}`);
      applyAction(structuredClone(round), round.turn, action);
    }
    // The engine still allows a human declarer to explicitly make the call.
    applyAction(structuredClone(round), round.turn, {type:'play', card:caller, jokerCall:true});
    assert.deepEqual(view, original);
  }
});

test('only the declarer who named the Joker loses the call option', () => {
  const {view} = reachLead(290575, 'N', 1, true);
  for (const control of [
    {...view, seat:1, selfRole:'opposition'},
    {...view, call:{kind:'card',card:'SA'}},
    {...view, call:{kind:'first'}},
    {...view, call:{kind:'none'}}
  ]) {
    assert.equal(protectCalledJoker(control), control);
  }
});
