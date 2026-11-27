import assert from 'node:assert/strict';
import test from 'node:test';
import {DECK, pointsIn} from '../engine.js';
import {applyAction, canDeclareSetting, createGame, getView, resolveSetting} from '../table-deal.js';
import {settlements} from '../table-scoring.js';
import {analyzeSetting} from '../table-claim.js';
import {rngFor} from '../lab/game.js';

function lateGame() {
  const game = createGame({random:rngFor(316)});
  const hands = [['SA','H9'], ['D10','C2'], ['CA','H3'], ['H2','D3'], ['C4','S5']];
  const discarded = ['HA','C3','D2'];
  const taken = DECK.filter(c => pointsIn([c]) && !hands.flat().includes(c) && !discarded.includes(c));
  const captured = [taken.slice(0,10), taken.slice(10,11), taken.slice(11,14),
    taken.slice(14,15), taken.slice(15)];
  return Object.assign(game, {phase:'play', declarer:0, turn:0, trickNo:9, hands, discarded, kitty:[],
    bid:{seat:0, points:14, suit:'N'}, call:{kind:'card', card:'CA'}, friend:2, friendKnown:false,
    scores:captured.map(pile => pile.length), captured});
}

function firstFriendGame(opening) {
  const game = createGame({random:rngFor(401)});
  const discarded = ['S10','D2','H2'];
  const rest = DECK.filter(card => !opening.includes(card) && !discarded.includes(card));
  const hands = opening.map((card, seat) => [card,...rest.slice(seat*9, (seat+1)*9)]);
  return Object.assign(game, {phase:'play', declarer:0, turn:0, hands, discarded, kitty:[],
    bid:{seat:0, points:14, suit:'N'}, call:{kind:'first'}, friend:null, friendKnown:false});
}

test('only the declarer on an empty lead may claim; player messages cannot supply the verdict', () => {
  const g = lateGame();
  for (let seat = 0; seat < 5; seat++) {
    assert.equal(getView(g,seat).choices.canDeclareSetting, false);
    assert.equal(getView(g,seat,true).choices.canDeclareSetting, seat === 0);
    assert.equal(getView(g,seat,true).choices.settingGuaranteed, seat === 0 ? true : undefined);
  }
  const initial = structuredClone(g);
  assert.throws(() => applyAction(g,0,{type:'setting', success:true}));
  assert.throws(() => resolveSetting(g,0,undefined));
  assert.throws(() => resolveSetting(g,1,false));
  assert.deepEqual(g,initial);
  applyAction(g,0,{type:'play',card:'H9'});
  const partial = structuredClone(g);
  for (let seat = 0; seat < 5; seat++) assert.equal(canDeclareSetting(g,seat), false);
  assert.throws(() => resolveSetting(g,0,true));
  assert.deepEqual(g,partial);
  assert.equal(canDeclareSetting(createGame({random:rngFor(5)}),0),false);
});

test('settle a proven claim with past wins, covered friend and buried points', () => {
  const g = lateGame(), earned = structuredClone(g.captured);
  const unplayedHonors = g.hands.flat().filter(card => pointsIn([card]));
  const old = g.scores.slice();
  assert.equal(getView(g,1).friend,null);
  const verdict = analyzeSetting(g);
  resolveSetting(g,0,verdict);
  assert.deepEqual(g.result.setting,{...verdict,remainingTricks:2,remainingPoints:3});
  assert.equal(g.result.friend,2);
  assert.equal(g.result.won,true);  // The buried ace already makes the 14-point contract.
  assert.equal(g.result.points, 17);
  assert.deepEqual(settlements(g.result,'N'),[20,-10,10,-10,-10]);
  assert.deepEqual(g.scores, old.map((p,s)=>p+(s===0 ? 4 : 0)));
  assert.deepEqual(g.captured.slice(1),earned.slice(1));
  assert.deepEqual(g.captured[0], [...earned[0],...unplayedHonors]);
  const assigned = [...g.captured.flat(),...g.discarded.filter(c=>pointsIn([c])),...(g.settingOppositionPile??[])];
  assert.equal(assigned.length,20);
  assert.equal(new Set(assigned).size,20);
  for (let seat=0;seat<5;seat++) {
    const v=getView(g,seat);
    assert.deepEqual(v.counts,[0,0,0,0,0]);
    assert.deepEqual(v.hand,[]);
    assert.deepEqual(v.captured[2],[]);
    assert.deepEqual(v.captured[0],[]);
    assert.deepEqual(v.discarded,seat===0?g.discarded:[]);
    assert.equal('settingOppositionPile' in v,false);
    assert.equal(v.settingPenaltyCards, undefined);
    assert.equal(v.friend,2);
    assert.equal(v.choices.canDeclareSetting,false);
  }
  const terminal=structuredClone(g);
  assert.throws(() => resolveSetting(g,0,verdict));
  assert.deepEqual(g,terminal);
});

test('a certified opening sweep makes a first-trick declarer play alone', () => {
  const g = firstFriendGame(['CA','C2','CK','CJ','C10']);
  const own = ['SA','SK','SQ','SJ','S10','S9','S8','S7','S6','S5'];
  g.discarded = ['JK','D2','H10'];
  const rest = DECK.filter(card => !own.includes(card) && !g.discarded.includes(card));
  g.hands = [own,...Array.from({length:4},(_,i)=>rest.slice(i*10,i*10+10))];
  const verdict = analyzeSetting(g);
  resolveSetting(g,0,verdict);
  assert.equal(g.phase,'result');
  assert.equal(g.result.points,20);
  assert.equal(g.result.friend,null);
  assert.deepEqual(g.result.setting,{...verdict,remainingTricks:10,remainingPoints:19});
  assert.deepEqual(g.playedTricks,[]);
  assert.deepEqual(settlements(g.result,'N'),[128,-32,-32,-32,-32]);
});

for (const [opening, friend] of [
  [['C2','CA','CK','CJ','C10'],1], [['CA','C2','CK','CJ','C10'],null]
]) {
  test('an opening penalty recorded by an older release can still finish, friend='+friend, () => {
    const g = firstFriendGame(opening);
    const before = structuredClone(g);
    assert.throws(()=>resolveSetting(g,0,{success:false}));
    assert.deepEqual(g,before);
    g.settingAwaitingFriend = true;
    assert.equal(g.phase,'play');
    assert.equal(g.result,null);
    assert.equal(g.turn,0);
    for(let seat=0;seat<5;seat++) {
      const v=getView(g,seat);
      assert.equal(v.settingAwaitingFriend,true);
      assert.equal(v.choices.canDeclareSetting,false);
      assert.equal(v.settingPenaltyCards,undefined);
      assert.equal(v.friend,null);
      assert.equal('settingOppositionPile' in v,false);
    }
    assert.throws(()=>resolveSetting(g,0,true));
    for(const card of opening) applyAction(g,g.turn,{type:'play',card});
    assert.equal(g.phase,'result');
    assert.equal(g.friendKnown,true);
    assert.equal(g.result.friend,friend);
    assert.equal(g.result.points,1);
    assert.equal(g.result.won,false);
    assert.deepEqual(g.result.setting,{success:false,remainingTricks:10,remainingPoints:19});
    assert.equal(g.settingOppositionPile.length,19);
    assert.equal(new Set([...g.settingOppositionPile,'S10']).size,20);
    assert.ok(opening.filter(card=>pointsIn([card])).every(card=>g.settingOppositionPile.includes(card)));
    assert.deepEqual(g.scores,[1,0,0,0,0]);
    assert.deepEqual(g.captured,[[],[],[],[],[]]);
    assert.equal(g.playedTricks.length,1);
    assert.equal(g.lastTrick.winner,friend??0);
    assert.equal(g.lastTrick.points,0);
    assert.equal(getView(g,2).settingAwaitingFriend,false);
  });
}
