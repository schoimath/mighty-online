import test from 'node:test';
import assert from 'node:assert/strict';
import {botObservation, mighty, winningPlay} from '../engine.js';
import {createGame, applyAction} from '../table-deal.js';
import {rngFor} from '../lab/game.js';
import {decideTableTurn, MODEL_CATALOG} from '../lab/table-agents.js';
import {conserveMightyOnTrumpAce} from '../table-tactics.js';

function friendTurn(seed, trump, opening, followers = [], points = 14) {
  const random = rngFor(seed);
  const state = createGame({random});
  const step = action => applyAction(state, state.turn, action, random);
  step({type:'bid', points, suit:trump});
  for (let i = 0; i < 4; i++) step({type:'pass'});
  const cards = state.hands[0].filter(c => c[0] !== trump && !c.endsWith('A') && c !== 'JK').slice(0,3);
  step({type:'discard', cards});
  step({type:'friend', kind:'card', card:mighty(trump)});
  for (const card of [...opening, trump + 'A', ...followers]) step({type:'play', card});
  const view = botObservation(state, state.turn);
  assert.equal(view.selfRole, 'friend');
  assert.equal(view.trickNo, 2);
  return view;
}

test('Mighty friend lets the declarer draw trumps with the ace while the Joker is unseen', () => {
  const opening = ['CA','C3','C10','CQ','CJ'];
  const view = friendTurn(921044, 'H', opening);
  const original = structuredClone(view);
  assert.equal(view.friendKnown, false);
  assert.equal(view.hand.includes('JK'), false);
  assert.deepEqual(view.trick, [{seat:0, card:'HA'}]);
  assert.ok(view.choices.plays.some(p => p.card === 'SA'));
  const allowed = conserveMightyOnTrumpAce(view);
  assert.deepEqual(allowed.choices.plays.map(p => p.card), ['HK','H10','H8','H5']);
  for (const {id} of MODEL_CATALOG) {
    const {action} = decideTableTurn({modelId:id, view, seed:17});
    assert.ok(allowed.choices.plays.some(p => p.card === action.card), id);
  }
  assert.deepEqual(view, original);

  // A live Joker could cost the 20-point bid here. Let the model price that risk.
  const critical = friendTurn(921044, 'H', opening, [], 20);
  assert.equal(conserveMightyOnTrumpAce(critical), critical);
});

test('a void friend can discard, and a friend holding both special cards conserves both', () => {
  const voidHand = friendTurn(921297, 'S', ['CA','C10','CQ','C5','C4'], ['S9']);
  assert.ok(voidHand.hand.every(card => card[0] !== 'S'));
  assert.deepEqual(conserveMightyOnTrumpAce(voidHand).choices.plays.map(p => p.card),
    voidHand.hand.filter(card => card !== 'DA'));

  const both = friendTurn(921093, 'S', ['HA','HQ','HJ','H10','DQ'], ['S5','S10','SJ']);
  assert.deepEqual(new Set(both.choices.plays.map(p => p.card)), new Set(['S8','DA','JK']));
  assert.deepEqual(conserveMightyOnTrumpAce(both).choices.plays, [{card:'S8'}]);
});

test('a Joker that already overtook the declarer can be beaten by the friend', () => {
  const view = friendTurn(921091, 'D', ['HA','H9','HQ','H6','HJ'], ['JK']);
  assert.equal(winningPlay(view).card, 'JK');
  assert.ok(view.choices.plays.some(p => p.card === 'SA'));
  assert.equal(conserveMightyOnTrumpAce(view), view);
});
