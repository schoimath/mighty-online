import assert from 'node:assert/strict';
import test from 'node:test';
import {applyAction, baselinePlay, botAction, botDecision, botObservation, createGame, getView, policyPlay} from '../engine.js';
import {sampler} from '../bot-sampling.js';

test('opponents’ unseen hands and covered piles cannot change a bot play', () => {
  const game = Object.assign(createGame(), {
    phase: 'play', turn: 2, trickNo: 4, bid: {seat: 0, suit: 'H', points: 15},
    declarer: 0, friend: 1, friendKnown: false, call: {kind: 'card', card: 'SA'},
    hands: [['CJ', 'D5'], ['SA', 'C6'], ['DK', 'H6'], ['SK', 'D7'], ['SQ', 'S3']],
    trick: [{seat: 1, card: 'C4'}]
  });
  const view = getView(game, 2);
  const move = botDecision(view);
  assert.ok(view.choices.plays.some(choice => choice.card === move.card));
  const alternate = structuredClone(game);
  [alternate.hands[1], alternate.hands[3]] = [alternate.hands[3], alternate.hands[1]];
  alternate.friend = 3;
  alternate.captured[0] = ['CA', 'HQ'];
  alternate.scores[0] = 2;
  assert.deepEqual(getView(alternate, 2), view);
  assert.deepEqual(botAction(alternate), move);
});

test('remembered plays contain face-up tricks only and stay out of room updates', () => {
  const game = createGame();
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const standard = [...['S','H','D','C'].flatMap(s => ranks.map(r => s+r)),'JK'];
  const dealt = standard.map((_,i) => standard[(i*23+7)%53]);
  game.hands = Array.from({length:5},(_,s) => dealt.slice(s*10,s*10+10));
  game.kitty = dealt.slice(50);
  applyAction(game,0,{type:'bid',points:14,suit:'H'});
  for (let i=0; i<4; i++) applyAction(game,game.turn,{type:'pass'});
  while (game.phase !== 'play' || game.trickNo < 3 || getView(game,game.turn).choices.plays.length < 2) {
    applyAction(game,game.turn,botDecision(getView(game,game.turn),baselinePlay));
  }
  const seat = game.turn, view = botObservation(game,seat);
  assert.equal(view.playedTricks.length,game.trickNo-1);
  assert.equal(view.playedTricks.flatMap(t => t.cards).length,5*(game.trickNo-1));
  assert.equal(view.hands,undefined);
  assert.equal(view.kitty,undefined);
  assert.equal(getView(game,seat).playedTricks,undefined);
  assert.deepEqual(botDecision(structuredClone(view)),botAction(game));
  const deck = [...game.hands.flat(), ...game.discarded, ...game.trick.map(p => p.card),
    ...game.playedTricks.flatMap(t => t.cards.map(p => p.card))];
  const draw = sampler(view,view.playedTricks,deck,game.bid.suit === 'S' ? 'DA' : 'SA',cards => cards.sort());
  assert.ok(draw);
  const imagined = draw();
  assert.ok(imagined);
  const alternate = {...game,hands:imagined.hands,discarded:imagined.discarded,friend:imagined.friend};
  assert.notDeepEqual(alternate.hands,game.hands);
  assert.deepEqual(botObservation(alternate,seat),view);
  assert.deepEqual(botAction(alternate),botAction(game));
  const legacy = {...game};
  delete legacy.playedTricks;
  const fallback = botAction(legacy);
  assert.deepEqual(fallback,{type:'play',...policyPlay(getView(legacy,seat))});
});

test('sampled worlds respect suit voids and forced Joker responses', () => {
  // On a Joker call, seats 2 and 4 played plain off-suit cards. Seat 3
  // answered with the Mighty, so it could still have clubs or the Joker.
  const cards = ['C3','C4','H2','SA','D3'];
  const trick = cards.map((card,seat) => ({seat,card,...(seat === 0 ? {jokerCall:true} : {})}));
  const history = [{number:1,winner:3,points:1,cards:trick}];
  const unknown = ['C5','C6','JK','H3','D4','D5','C7'];
  const view = {seat:0,hand:['SQ'],discarded:[],declarer:1,counts:[1,1,1,1,1],
    bid:{suit:'H'},call:{kind:'none'},friendKnown:true,friend:null,trick:[],trickNo:2};
  const draw = sampler(view,history,[...cards,...view.hand,...unknown],'SA',hand => hand.sort());
  let sawJoker = false;
  for (let i = 0; i < 200; i++) {
    const sample = draw();
    assert.ok(sample);
    for (const seat of [2,4]) assert.ok(sample.hands[seat].every(card => card !== 'JK' && card[0] !== 'C'));
    assert.equal(new Set([...sample.hands.flat(), ...sample.discarded]).size,8);
    sawJoker ||= sample.hands[3].includes('JK');
  }
  assert.ok(sawJoker);
});
