import test from 'node:test';
import assert from 'node:assert/strict';
import {legalPlays} from '../engine.js';
import {analyzeSetting} from '../table-claim.js';
import {applyAction, createGame, getView, resolveSetting} from '../table-deal.js';
import {rngFor} from '../lab/game.js';

function endgame(hands, rules={}) {
  const game = createGame({random:rngFor(56), rules});
  return Object.assign(game, {hands, phase:'play', turn:2, declarer:2, bid:{seat:2,suit:'H',points:14},
    call:{kind:'none'}, friendKnown:true, discarded:[], trickNo:11 - hands[2].length});
}

function mustCall() {
  return endgame([['S8','S4'], ['D6','D5'], ['HA','C3'], ['JK','C2'], ['D4','D2']]);
}

test('a successful claim shows the forced Joker call before the ace to every seat', () => {
  const game = mustCall();
  const verdict = analyzeSetting(game);
  assert.deepEqual(verdict, {success:true,line:[{card:'C3',jokerCall:true},{card:'HA'}]});
  const replay = structuredClone(game);
  for (const lead of verdict.line) {
    applyAction(replay,replay.turn,{type:'play',...lead});
    for (let i = 0; i < 4; i++) {
      const reply = legalPlays(replay,replay.hands[replay.turn])[0];
      applyAction(replay,replay.turn,{type:'play',...reply});
    }
    assert.equal(replay.lastTrick.winner,2);
  }
  resolveSetting(game,2,verdict);
  for (let seat = 0; seat < 5; seat++) {
    assert.deepEqual(getView(game,seat).result.setting.line,verdict.line);
  }
});

test('a ninth-trick claim includes the demanded suit for the final Joker and a failed claim reveals no line', () => {
  const hands = [['H2','H3'],['D3','D2'],['HA','JK'],['D4','D5'],['H4','H5']];
  const game = endgame(hands,{allowLastJoker:true});
  const verdict = analyzeSetting(game);
  assert.equal(verdict.success,true);
  assert.deepEqual(verdict.line.map(move => move.card), ['HA','JK']);
  assert.ok(['S','H','D','C'].includes(verdict.line[1].suit));
  resolveSetting(game,2,verdict);
  assert.deepEqual(getView(game,1).result.setting.line,verdict.line);

  const lost = endgame([['SA','H3'], ...hands.slice(1)]);
  const failed = analyzeSetting(lost);
  assert.deepEqual(failed,{success:false});
  const before = structuredClone(lost);
  assert.throws(() => resolveSetting(lost,2,failed));
  assert.deepEqual(lost,before);
});

test('malformed or repeated leads cannot clear the hands or settle the claim', () => {
  for (const line of [[],[{card:'HA'},{card:'HA'}],[{card:'D6'},{card:'C3'}],
    [{card:'C3',suit:'S'},{card:'HA'}],Array(2)]) {
    const game = mustCall(), before = structuredClone(game);
    assert.throws(() => resolveSetting(game,2,{success:true,line}));
    assert.deepEqual(game,before);
  }
});
