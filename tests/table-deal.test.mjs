import assert from 'node:assert/strict';
import test from 'node:test';
import {createGame as rawDeal, DECK, getView as rawView, pointsIn} from '../engine.js';
import {rngFor} from '../lab/game.js';
import {applyAction, createGame, getSpectatorView, getTableBotObservation, getView} from '../table-deal.js';
import {LEGACY_TABLE_SCORING_VERSION, TABLE_SCORING_VERSION} from '../table-scoring.js';

function pass(game, random) {
  applyAction(game, game.turn, {type: 'pass'}, random);
}

function winAuction(allowFirstFriend) {
  const game = createGame({random:rngFor(317), rules:{allowFirstFriend}});
  applyAction(game, 0, {type:'bid', suit:'H', points:14});
  for (let seat = 1; seat < 5; seat++) pass(game);
  return game;
}

test('preparing the contract, burial and friend matches legacy turns and preserves both private bot observations', () => {
  const original = winAuction(true), hand = original.hands[0];
  const cards = hand.slice(0,3), contract = {suit:'D', points:16};
  const calls = [{kind:'card',card:original.hands[1][0]}, {kind:'card',card:cards[0]},
    {kind:'card',card:hand[3]}, {kind:'first'}, {kind:'none'}];
  for (const friend of calls) {
    const legacy = structuredClone(original), combined = structuredClone(original);
    const legacyHistory = [], combinedHistory = [];
    applyAction(legacy, 0, {type:'discard', cards, contract}, undefined, legacyHistory);
    applyAction(legacy, 0, {type:'friend', ...friend}, undefined, legacyHistory);
    const action = {type:'prepare', cards, contract, friend};
    applyAction(combined, 0, action, undefined, combinedHistory);
    assert.deepEqual(combined, legacy);
    assert.deepEqual(combinedHistory, legacyHistory);
    const [burial, call] = combinedHistory;
    assert.equal(burial.observation.scoringVersion, TABLE_SCORING_VERSION);
    assert.equal(burial.observation.phase, 'discard');
    assert.deepEqual(burial.action.contract, {seat:0,...contract});
    assert.equal(call.observation.phase, 'friend');
    assert.deepEqual(call.observation.hand, hand.slice(3));
    assert.deepEqual(call.observation.discarded, cards);
    assert.equal(combined.phase, 'play');
    assert.equal(combined.turn, 0);
    assert.throws(() => applyAction(combined, 0, action, undefined, combinedHistory));
    assert.deepEqual(combinedHistory, legacyHistory);
    assert.deepEqual(combined, legacy);
  }
});

test('discard choices are private and invalid combined preparations leave the original turn and memory intact', () => {
  const game = winAuction(false), cards = game.hands[0].slice(0,3);
  const choices = getView(game,0).choices.discardFriends;
  assert.deepEqual(choices, [...DECK.map(card => ({kind:'card',card})), {kind:'none'}]);
  assert.equal(getView(game,1).choices.discardFriends, undefined);
  assert.equal(getSpectatorView(game).choices.discardFriends, undefined);
  const action = {type:'prepare', cards, friend:{kind:'none'}};
  const before = structuredClone(game), history = [];
  for (const [seat, fields] of [[0,{friend:{kind:'first'}}], [0,{friend:{kind:'card',card:'XX'}}],
    [0,{friend:undefined}], [0,{cards:[cards[0],cards[0],cards[1]]}], [0,{contract:{suit:'D',points:15}}], [1,{}]]) {
    assert.throws(() => applyAction(game, seat, {...action, ...fields}, undefined, history));
    assert.deepEqual(game, before);
    assert.deepEqual(history, []);
  }
});

test('all five original ten-card hands must contain a point; joker alone cannot prevent a misdeal', () => {
  const seeds = [99, 575, 192, 84, 66];
  for (const [seat, seed] of seeds.entries()) {
    const random = rngFor(seed);
    let expected = rawDeal({random});
    assert.equal(pointsIn(expected.hands[seat]), 0);
    if (seed === 66) assert.ok(expected.hands[seat].includes('JK'));
    let discarded = 0;
    while (expected.hands.some(hand => !pointsIn(hand))) {
      discarded++;
      expected = rawDeal({random});
    }
    const live = createGame({firstSeat: seat, random: rngFor(seed)});
    assert.equal(live.firstSeat, seat);
    assert.equal(live.turn, seat);
    assert.equal(live.dealNo, 1);
    assert.equal(live.misdealCount, discarded);
    assert.deepEqual(live.hands, expected.hands);
    assert.deepEqual(live.kitty, expected.kitty);
    for (let viewer = 0; viewer < 5; viewer++) {
      const {misdealCount, scoringVersion, ...visible} = getView(live, viewer);
      assert.equal(misdealCount, discarded);
      assert.equal(scoringVersion, TABLE_SCORING_VERSION);
      assert.deepEqual(visible, rawView(live, viewer));
    }
  }
});

test('a single ten or ace qualifies, and consecutive misdeals are all discarded', () => {
  for (const [seed, onePoint] of [[0, card => card.endsWith('10')], [14, card => card === 'SA']]) {
    const game = createGame({random: rngFor(seed)});
    assert.equal(game.misdealCount, 0);
    assert.ok(game.hands.some(hand => pointsIn(hand) === 1 && hand.some(onePoint)));
  }
  const game = createGame({random: rngFor(698)});
  assert.ok(game.misdealCount >= 2);
  assert.equal(new Set([...game.hands.flat(), ...game.kitty]).size, 53);
});

test('an all-pass auction checks the next deal and rotates the opening seat exactly once', () => {
  const rules = {minBid: 16, allowLastJoker: true};
  const random = rngFor(67);
  const game = createGame({firstSeat: 4, rules, random});
  assert.equal(game.misdealCount, 0);
  for (let n = 0; n < 5; n++) pass(game, random);
  assert.equal(game.dealNo, 2);
  assert.equal(game.firstSeat, 0);
  assert.equal(game.turn, 0);
  assert.ok(game.misdealCount > 0);
  assert.equal(game.scoringVersion, TABLE_SCORING_VERSION);
  assert.ok(game.hands.every(hand => pointsIn(hand) >= 1));
  assert.equal(game.rules.minBid, 16);
  assert.equal(game.rules.allowLastJoker, true);
  assert.deepEqual(game.bidHistory, []);
  for (let n = 0; n < 5; n++) pass(game, rngFor(0));
  assert.equal(game.misdealCount, 0);
  assert.equal(game.dealNo, 3);
  assert.equal(game.turn, 1);
});

test('restored unversioned hands keep their original scoring even after a forced redeal', () => {
  const random = rngFor(67);
  const restored = createGame({firstSeat:4, random});
  delete restored.scoringVersion;
  assert.equal(getView(restored,0).scoringVersion, LEGACY_TABLE_SCORING_VERSION);
  assert.equal(getSpectatorView(restored).scoringVersion, LEGACY_TABLE_SCORING_VERSION);
  assert.equal(getTableBotObservation(restored,0).scoringVersion, LEGACY_TABLE_SCORING_VERSION);
  for (let n = 0; n < 5; n++) pass(restored, random);
  assert.ok(restored.misdealCount > 0);
  assert.equal(restored.scoringVersion, LEGACY_TABLE_SCORING_VERSION);
  assert.equal(getSpectatorView(createGame({random})).scoringVersion, TABLE_SCORING_VERSION);
});

test('a broken random source cannot loop forever or partially commit the final pass', () => {
  for (const value of [0.039, 1 - Number.EPSILON, 1, NaN]) {
    assert.throws(() => createGame({random: () => value}), /난수|섞지/);
  }
  const game = createGame({random: rngFor(0)});
  for (let n = 0; n < 4; n++) pass(game);
  const before = structuredClone(game);
  assert.throws(() => pass(game, () => 0.039), /섞지/);
  assert.deepEqual(game, before);
  pass(game, rngFor(14));
  assert.equal(game.dealNo, 2);
});
