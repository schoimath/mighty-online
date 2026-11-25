import assert from 'node:assert/strict';
import test from 'node:test';
import {DECK, pointsIn} from '../engine.js';
import {applyAction, canDeclareSetting, createGame, getView, resolveSetting} from '../table-deal.js';
import {settlements} from '../table-scoring.js';
import {rngFor} from '../lab/game.js';

function lateGame() {
  const game = createGame({random:rngFor(316)});
  const hands = [['SA','H2'], ['D10','C2'], ['CA','H3'], ['H9','D3'], ['C4','S5']];
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
    assert.equal(getView(g,seat).choices.canDeclareSetting, seat === 0);
  }
  const initial = structuredClone(g);
  assert.throws(() => applyAction(g,0,{type:'setting', success:true}));
  assert.throws(() => resolveSetting(g,0,undefined));
  assert.throws(() => resolveSetting(g,1,false));
  assert.deepEqual(g,initial);
  applyAction(g,0,{type:'play',card:'H2'});
  const partial = structuredClone(g);
  for (let seat = 0; seat < 5; seat++) assert.equal(canDeclareSetting(g,seat), false);
  assert.throws(() => resolveSetting(g,0,true));
  assert.deepEqual(g,partial);
  assert.equal(canDeclareSetting(createGame({random:rngFor(5)}),0),false);
});

for (const success of [true,false]) {
  test('settle a '+(success?'made':'failed')+' claim with past wins, covered friend and buried points', () => {
    const g = lateGame(), earned = structuredClone(g.captured);
    const unplayedHonors = g.hands.flat().filter(card => pointsIn([card]));
    const old = g.scores.slice();
    assert.equal(getView(g,1).friend,null);
    resolveSetting(g,0,success);
    assert.deepEqual(g.result.setting,{success,remainingTricks:2,remainingPoints:3});
    assert.equal(g.result.friend,2);
    assert.equal(g.result.won,true);  // The buried ace already makes the 14-point contract.
    assert.equal(g.result.points, success ? 17 : 14);
    assert.deepEqual(settlements(g.result,'N'),success ? [20,-10,10,-10,-10] : [8,-4,4,-4,-4]);
    assert.deepEqual(g.scores, old.map((p,s)=>p+(s===0 ? (success?4:1) : 0)));
    assert.deepEqual(g.captured.slice(1),earned.slice(1));
    if (success) assert.deepEqual(g.captured[0], [...earned[0],...unplayedHonors]);
    else {
      assert.deepEqual(g.captured[0],earned[0]);
      assert.deepEqual(new Set(g.settingOppositionPile),new Set(unplayedHonors));
    }
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
      if (success) assert.equal(v.settingPenaltyCards, undefined);
      else assert.deepEqual(v.settingPenaltyCards, g.settingOppositionPile);
      assert.equal(v.friend,2);
      assert.equal(v.choices.canDeclareSetting,false);
    }
    const terminal=structuredClone(g);
    assert.throws(() => resolveSetting(g,0,!success));
    assert.deepEqual(g,terminal);
  });
}

test('a certified opening sweep makes a first-trick declarer play alone', () => {
  const g = firstFriendGame(['CA','C2','CK','CJ','C10']);
  resolveSetting(g,0,true);
  assert.equal(g.phase,'result');
  assert.equal(g.result.points,20);
  assert.equal(g.result.friend,null);
  assert.deepEqual(g.result.setting,{success:true,remainingTricks:10,remainingPoints:19});
  assert.deepEqual(g.playedTricks,[]);
  assert.deepEqual(settlements(g.result,'N'),[256,-64,-64,-64,-64]);
});

for (const [opening, friend] of [
  [['C2','CA','CK','CJ','C10'],1], [['CA','C2','CK','CJ','C10'],null]
]) {
  test('failed opening claim counts the friend-deciding trick in the team penalty, friend='+friend, () => {
    const g = firstFriendGame(opening);
    resolveSetting(g,0,false);
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
