import test from 'node:test';
import assert from 'node:assert/strict';
import {DECK, DEFAULT_RULES, legalPlays, winningPlay} from '../engine.js';
import {rngFor} from '../lab/game.js';
import {analyzeSetting, canSweepRemaining} from '../table-claim.js';

function position(hands, suit='H', rules={}, declarer=0) {
  return {phase:'play', turn:declarer, declarer, hands, bid:{suit}, trick:[],
    trickNo:11-hands[0].length, rules:{...DEFAULT_RULES,...rules}};
}

// Independent, intentionally uncompressed AND/OR search over individual legal
// cards. All four followers choose in order, including the declarer's friend.
function exhaustive(state) {
  const {declarer, turn, hands, trick} = state;
  if (trick.length === 5) {
    if (winningPlay(state).seat !== declarer) return false;
    return !hands[declarer].length || exhaustive({...state,turn:declarer,trick:[],trickNo:state.trickNo+1});
  }
  const choices = legalPlays(state,hands[turn]);
  const play = move => {
    const nextHands = [...hands];
    nextHands[turn] = hands[turn].filter(card => card !== move.card);
    return exhaustive({...state,hands:nextHands,turn:(turn+1)%5,trick:[...trick,{seat:turn,...move}]});
  };
  return turn===declarer ? choices.some(play) : choices.every(play);
}

test('claim requires the declarer to take even a pointless trick and never relies on the friend', () => {
  const friendCanRuff = position([['HA','D7'],['H2','S4'],['H7','C5'],['H9','D8'],['H3','C2']]);
  friendCanRuff.friend=3;
  assert.equal(canSweepRemaining(friendCanRuff),false);
  const outsideMighty=position([['JK','HA'],['SA','D2'],['H3','C2'],['H2','D3'],['H4','C3']]);
  outsideMighty.friend=1;
  assert.equal(canSweepRemaining(outsideMighty),false);
  assert.equal(canSweepRemaining(position([['H2'],['D4'],['D3'],['S3'],['C8']],'S')),false);
  assert.equal(canSweepRemaining(position([['D4'],['D3'],['D2'],['H2'],['C2']],'N')),true);
});

test('claim search follows opening leads, Joker calls, special Mighty suit and last Joker settings', () => {
  const last=position([['JK'],['H10'],['HQ'],['H2'],['DA']]);
  assert.equal(canSweepRemaining(last),false);
  assert.equal(canSweepRemaining({...last,rules:{...last.rules,allowLastJoker:true}}),true);
  const spade=position([['DA'],['SA'],['JK'],['S10'],['D10']],'S');
  assert.equal(canSweepRemaining(spade),true);
  const call=position([['C3','HA'],['JK','C2'],['D4','D2'],['S8','S4'],['D6','D5']]);
  assert.equal(canSweepRemaining(call),true);
  const opening={...call,trickNo:1};
  assert.equal(canSweepRemaining(opening),false);
  assert.equal(canSweepRemaining({...opening,rules:{...opening.rules,allowFirstJokerCall:true}}),true);
  const clubCaller=position([['S3','CA'],['JK','S2'],['D4','D2'],['H8','H4'],['D6','D5']],'C');
  assert.equal(canSweepRemaining(clubCaller),true);
  const shifted=position([['S3','CA'],['JK','S2'],['D4','D2'],['S5','S4'],['D6','D5']],'C');
  assert.equal(canSweepRemaining(shifted),false);
  const inactive=position([['JK','HA'],['C3','C2'],['D3','D2'],['S5','S4'],['D6','D5']]);
  assert.equal(canSweepRemaining({...inactive,trickNo:1}),false);
});

test('a defender may immediately overtake even when it could have discarded a lower card in that suit', () => {
  const g=position([['H10','H9'],['H2','HJ'],['C7','C2'],['S4','S2'],['CQ','CJ']]);
  assert.equal(canSweepRemaining(g),false);
});

test('exact result agrees with a separate full engine-move search across small deals', () => {
  const rng=rngFor(20261126);
  let wins=0,losses=0;
  for(let i=0;i<360;i++) {
    const count=1+i%3, trump=['H','S','N','C','D'][i%5], declarer=Math.floor(i/5)%5;
    const shuffled=[...DECK];
    for(let j=shuffled.length-1;j>0;j--) {
      const k=Math.floor(rng()*(j+1));
      [shuffled[j],shuffled[k]]=[shuffled[k],shuffled[j]];
    }
    const hands=Array.from({length:5},(_,seat)=>shuffled.slice(seat*count,seat*count+count));
    const state=position(hands,trump,{allowLastJoker:!!(i%2),allowFirstJokerCall:!!(i%4)},declarer);
    if(i%7===0) state.trickNo=1;
    const original=structuredClone(state);
    const verdict=exhaustive(state);
    assert.equal(canSweepRemaining(state),verdict,JSON.stringify(state));
    assert.deepEqual(state,original);
    if(verdict) wins++; else losses++;
  }
  assert.ok(wins>20 && losses>20);
});

test('ten winning trumps can be claimed with arbitrary off-suit discards', () => {
  const cards=['H5','H6','H7','H8','H9','H10','HJ','HQ','HK','HA'];
  const side=DECK.filter(c=>!cards.includes(c) && c!=='SA' && c!=='JK');
  const game=position([cards,...Array.from({length:4},(_,i)=>side.slice(10*i,10*i+10))]);
  assert.deepEqual(analyzeSetting(game,{maxWork:1}),{success:false,indeterminate:true});
  assert.equal(canSweepRemaining(game),true);
  assert.throws(()=>canSweepRemaining({...game,turn:3}));
  assert.throws(()=>canSweepRemaining({...game,trick:[{seat:0,card:'H5'}]}));
});

test('high-card declarer hands agree with the exhaustive tree when followers can discard in several suits', () => {
  const rng=rngFor(360122);
  for(let i=0;i<30;i++) {
    const cards=DECK.map(c=>({c,order:rng()})).sort((a,b)=>a.order-b.order).map(x=>x.c);
    const own=[['SA','JK','HA','HK'],['SA','DA','HA','CA'],['SA','H10','HK','D7']][i%3];
    const rest=cards.filter(c=>!own.includes(c));
    const hands=[own,...Array.from({length:4},(_,seat)=>rest.slice(seat*4,seat*4+4))];
    const g=position(hands,i%2?'H':'N',{allowLastJoker:i%4<2});
    assert.equal(canSweepRemaining(g),exhaustive(g),JSON.stringify(g));
  }
});
