import assert from 'node:assert/strict';
import test from 'node:test';
import {createGame as rawDeal, getView as rawView, pointsIn} from '../engine.js';
import {rngFor} from '../lab/game.js';
import {applyAction, createGame, getView} from '../table-deal.js';

function pass(game, random) {
  applyAction(game, game.turn, {type: 'pass'}, random);
}

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
      const {misdealCount, ...visible} = getView(live, viewer);
      assert.equal(misdealCount, discarded);
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
  assert.ok(game.hands.every(hand => pointsIn(hand) >= 1));
  assert.equal(game.rules.minBid, 16);
  assert.equal(game.rules.allowLastJoker, true);
  assert.deepEqual(game.bidHistory, []);
  for (let n = 0; n < 5; n++) pass(game, rngFor(0));
  assert.equal(game.misdealCount, 0);
  assert.equal(game.dealNo, 3);
  assert.equal(game.turn, 1);
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
