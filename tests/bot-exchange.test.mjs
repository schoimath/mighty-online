import assert from 'node:assert/strict';
import test from 'node:test';
import {applyAction, botAction, createGame} from '../engine.js';

test('a bot banks vulnerable honors and creates a void while preserving trump, Joker and Mighty', () => {
  const cases = [
    {trump:'H', hand:'SA JK H2 H4 H6 H8 H10 HQ HA D10 C10 C2 S2', buried:['D10','C10','C2']},
    {trump:'S', hand:'JK DA S2 S3 S4 S8 S10 SQ SA D10 C10 H2 C2', buried:['D10','C10','H2']}
  ];
  for (const {trump, hand, buried} of cases) {
    const game = Object.assign(createGame(), {phase:'discard', turn:0, declarer:0, bid:{seat:0, suit:trump, points:14}});
    game.hands[0] = hand.split(' ');
    const action = botAction(game);
    assert.deepEqual(action.cards, buried);
    applyAction(game, 0, action);
    assert.equal(game.phase, 'friend');
    assert.equal(game.hands[0].length, 10);
  }
});
