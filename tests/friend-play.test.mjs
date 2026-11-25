import test from 'node:test';
import assert from 'node:assert/strict';
import {botObservation, legalPlays, mighty} from '../engine.js';
import {createGame, applyAction} from '../table-deal.js';
import {coordinateFriendPlay} from '../table-friend-play.js';
import {rngFor} from '../lab/game.js';
import {decideTableTurn, memoryForReplacement, MODEL_CATALOG} from '../lab/table-agents.js';

// Replay the public decisions from two real deals, retaining each seat's
// own pre-play history for the recurrent model.
function deal(seed, suit, buried, plays) {
  const state = createGame({random:rngFor(seed)});
  const history = Array.from({length:5}, () => []);
  const step = action => {
    const seat = state.turn;
    history[seat].push({observation:botObservation(state, seat), action});
    applyAction(state, seat, action);
  };
  step({type:'bid', points:15, suit});
  for (let i = 0; i < 4; i++) step({type:'pass'});
  for (const card of [mighty(suit), 'JK', suit + 'A']) assert.ok(state.hands[0].includes(card));
  step({type:'discard', cards:buried});
  step({type:'friend', kind:'card', card:'HA'});
  for (const card of plays) step({type:'play', card});
  return {view:botObservation(state, state.turn), history:history[state.turn]};
}

const giveLead = () => deal(23223116, 'S', ['H10','DQ','C4'], ['H5']);
const giveBack = () => deal(23222818, 'D', ['S10','H10','C10'], ['H5','H4','HA','HQ','H2']);
const play = card => ({type:'play', card});

test('all three live friends take the opening invitation and return a low trump', () => {
  for (const [position, card] of [[giveLead(), 'HA'], [giveBack(), 'D3']]) {
    const {view, history} = position;
    const original = structuredClone(view);
    assert.equal(view.selfRole, 'friend');
    for (const {id} of MODEL_CATALOG) {
      const memory = memoryForReplacement(id, history);
      assert.equal(decideTableTurn({modelId:id, view, memory, seed:22}).action.card, card, id);
    }
    assert.deepEqual(view, original);
  }
});

function withPlays(base, changes) {
  const view = {...base, ...changes};
  view.choices = {...base.choices, plays:legalPlays(view, view.hand)};
  return view;
}

test('a called ace does not overtake an existing cut or a cheaper winning card in last seat', () => {
  const {view} = giveLead();
  const cut = withPlays(view, {seat:2, trick:[...view.trick, {seat:1,card:'S2'}]});
  assert.deepEqual(coordinateFriendPlay(cut, play('HJ')), play('HJ'));
  const last = withPlays(view, {seat:4, trick:[...view.trick,
    {seat:1,card:'H9'}, {seat:2,card:'H2'}, {seat:3,card:'H4'}]});
  assert.deepEqual(coordinateFriendPlay(last, play('HJ')), play('HJ'));
  assert.deepEqual(coordinateFriendPlay({...view, selfRole:'opposition'}, play('HJ')), play('HJ'));
});

test('the friend can keep a cashable side winner or make an intentional Joker call on lead', () => {
  const {view} = giveBack();
  const returnView = withPlays(view, {hand:[...view.hand.slice(0,-2), 'SK','C3']});
  const call = {type:'play', card:'C3', jokerCall:true};
  assert.ok(returnView.choices.plays.some(p => p.card === 'C3' && p.jokerCall));
  assert.deepEqual(coordinateFriendPlay(returnView, call), call);
  // In diamonds the spade ace is the Mighty. The spade king is the
  // highest ordinary spade left, even though the ace is still unseen.
  assert.deepEqual(coordinateFriendPlay(returnView, play('SK')), play('SK'));
});

test('the friend banks a vulnerable point on a certain trick and keeps it under threat', () => {
  const {view} = giveBack();
  const safe = withPlays(view, {trickNo:4, hand:['S6','S10','SK','C2'],
    trick:[{seat:0,card:'SA'},{seat:1,card:'S2'}]});
  assert.deepEqual(coordinateFriendPlay(safe, play('S6')), play('S10'));
  const threatened = withPlays(safe, {trick:[{seat:0,card:'SJ'},{seat:1,card:'S2'}]});
  assert.deepEqual(coordinateFriendPlay(threatened, play('S6')), play('S6'));
  const forced = withPlays(view, {trick:[{seat:0,card:'C3',jokerCall:true}], hand:['JK','CJ','D2']});
  assert.deepEqual(forced.choices.plays, [{card:'JK'}]);
  assert.deepEqual(coordinateFriendPlay(forced, play('JK')), play('JK'));
});
