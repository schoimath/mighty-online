import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, botAction, createGame, getView } from '../engine.js';

function act(game, action) {
  applyAction(game, game.turn, action);
}
function reject(game, action, seat = game.turn) {
  const before = structuredClone(game);
  assert.throws(() => applyAction(game, seat, action));
  assert.deepEqual(game, before);
}
function playFixture(hands, trump = 'H', trickNo = 2) {
  return {
    ...createGame(), phase: 'play', hands, declarer: 0, turn: 0,
    bid: { seat: 0, points: 13, suit: trump }, call: { kind: 'none' }, friendKnown: true,
    trickNo, kitty: []
  };
}
const play = (game, card, fields = {}) => act(game, { type: 'play', card, ...fields });
const legal = game => getView(game, game.turn).choices.plays;

test('53 unique cards, ten per player, with private isolated views', () => {
  const game = createGame({ firstSeat: 3 });
  const deck = [...game.hands.flat(), ...game.kitty];
  assert.equal(deck.length, 53);
  assert.equal(new Set(deck).size, 53);
  assert.equal(game.turn, 3);
  const view = getView(game, 1);
  assert.deepEqual(view.counts, [10, 10, 10, 10, 10]);
  assert.equal(view.hands, undefined);
  assert.equal(view.kitty, undefined);
  assert.deepEqual(view.choices.bids, []);
  view.hand.pop();
  assert.equal(game.hands[1].length, 10);
  assert.throws(() => getView(game, -1));
});

test('contracts rise, no trump wins ties, passers are skipped, all-pass redeals', () => {
  const game = createGame();
  reject(game, { type: 'bid', suit: 'C', points: 14 }, 1);
  reject(game, { type: 'bid', suit: 'C', points: 12 });
  act(game, { type: 'bid', suit: 'C', points: 13 });
  reject(game, { type: 'bid', suit: 'D', points: 13 });
  act(game, { type: 'bid', suit: 'N', points: 13 });
  act(game, { type: 'pass' });
  act(game, { type: 'bid', suit: 'C', points: 14 });
  for (let i = 0; i < 3; i++) act(game, { type: 'pass' });
  assert.equal(game.phase, 'discard');
  assert.equal(game.turn, 3);
  assert.deepEqual(game.hands.map(h => h.length), [10, 10, 10, 13, 10]);
  const redeal = createGame();
  for (let i = 0; i < 5; i++) act(redeal, { type: 'pass' });
  assert.equal(redeal.dealNo, 2);
  assert.equal(redeal.turn, 1);
  assert.deepEqual(redeal.bidHistory, []);
});

test('valid exchange, contract switch and delayed called-card friend reveal', () => {
  const game = createGame();
  act(game, { type: 'bid', points: 13, suit: 'H' });
  for (let i = 0; i < 4; i++) act(game, { type: 'pass' });
  const cards = game.hands[0].slice(0, 3);
  reject(game, { type: 'discard', cards: [cards[0], cards[0], cards[1]] });
  reject(game, { type: 'discard', cards, contract: { points: 14, suit: 'N' } });
  act(game, { type: 'discard', cards, contract: { points: 15, suit: 'N' } });
  assert.deepEqual(game.bid, { seat: 0, points: 15, suit: 'N' });
  assert.deepEqual(getView(game, 0).discarded, cards);
  assert.deepEqual(getView(game, 1).discarded, []);
  assert.equal(game.hands[0].length, 10);
  const card = game.hands[1][0];
  act(game, { type: 'friend', kind: 'card', card });
  assert.equal(getView(game, 0).friend, null);
  assert.equal(getView(game, 0).friendKnown, false);
  assert.equal(getView(game, 1).selfRole, 'friend');
  assert.equal(getView(game, 2).selfRole, 'opposition');
  // Start a trick with the holder to exercise the reveal for every random deal.
  game.turn = 1;
  play(game, card);
  assert.equal(getView(game, 2).friend, 1);
  assert.equal(getView(game, 0).friendKnown, true);
});

test('first lead avoids trump unless forced, follow suit except the Mighty or Joker', () => {
  const game = playFixture([['H3', 'C2'], ['DA', 'CK', 'H5', 'JK', 'SA'], [], [], []], 'H', 1);
  assert.deepEqual(legal(game), [{ card: 'C2' }]);
  reject(game, { type: 'play', card: 'H3' });
  play(game, 'C2');
  assert.deepEqual(legal(game).map(p => p.card), ['CK', 'JK', 'SA']);
  reject(game, { type: 'play', card: 'H5' });
  const onlyTrumps = playFixture([['H3', 'H4'], [], [], [], []], 'H', 1);
  assert.equal(legal(onlyTrumps).length, 2);
  const loneMighty = playFixture([['S4'], ['SA', 'H4'], [], [], []]);
  play(loneMighty, 'S4');
  assert.deepEqual(legal(loneMighty), [{ card: 'SA' }]);
});

test('spade trump moves the Mighty, club trump moves the Joker call', () => {
  const game = playFixture([['SA'], ['JK'], ['DA'], ['SK'], ['S2']], 'S');
  for (const card of ['SA', 'JK', 'DA', 'SK', 'S2']) play(game, card);
  assert.equal(game.lastTrick.winner, 2);
  assert.equal(game.lastTrick.points, 3);
  const clubs = playFixture([['C3', 'S3'], ['JK', 'SA', 'SQ'], [], [], []], 'C');
  assert.deepEqual(legal(clubs), [{ card: 'C3' }, { card: 'S3' }, { card: 'S3', jokerCall: true }]);
  play(clubs, 'S3', { jokerCall: true });
  assert.deepEqual(legal(clubs), [{ card: 'JK' }, { card: 'SA' }]);
  reject(clubs, { type: 'play', card: 'SQ' });
});

test('the Joker is forced and powerless when called; first trick disallows calls', () => {
  const game = playFixture([['C3'], ['JK', 'CA'], ['C7'], ['H3'], ['HK']]);
  play(game, 'C3', { jokerCall: true });
  assert.deepEqual(legal(game), [{ card: 'JK' }]);
  for (const card of ['JK', 'C7', 'H3', 'HK']) play(game, card);
  assert.equal(game.lastTrick.winner, 4);
  const first = playFixture([['C3'], [], [], [], []], 'H', 1);
  reject(first, { type: 'play', card: 'C3', jokerCall: true });
});

test('Joker leads call a suit in middle tricks; first and last trick Joker loses', () => {
  const middle = playFixture([['JK'], ['C2', 'H5'], ['HA'], ['S7'], ['H4']]);
  reject(middle, { type: 'play', card: 'JK' });
  play(middle, 'JK', { suit: 'H' });
  assert.deepEqual(legal(middle), [{ card: 'H5' }]);
  for (const card of ['H5', 'HA', 'S7', 'H4']) play(middle, card);
  assert.equal(middle.lastTrick.winner, 0);
  for (const trickNo of [1, 10]) {
    const game = playFixture([['JK'], ['CQ'], ['C2', 'DA'], ['CA'], ['SK']], 'N', trickNo);
    play(game, 'JK');
    play(game, 'CQ');
    assert.deepEqual(legal(game), [{ card: 'C2' }]);
    for (const card of ['C2', 'CA', 'SK']) play(game, card);
    assert.equal(game.lastTrick.winner, 3);
  }
});

test('first-trick friend resolves once, declarer winning it plays alone', () => {
  for (const [lead, expected] of [['CA', null], ['C2', 1]]) {
    const game = playFixture([[lead], ['CK'], ['C6'], ['D5'], ['C4']], 'N', 1);
    game.call = { kind: 'first' };
    game.friendKnown = false;
    assert.equal(getView(game, 2).selfRole, 'unknown');
    for (const card of [lead, 'CK', 'C6', 'D5', 'C4']) play(game, card);
    assert.equal(game.friend, expected);
    assert.equal(game.friendKnown, true);
  }
});

test('point-card piles appear on completed tricks and buried points stay private until the result', () => {
  const cards = ['H10', 'HJ', 'HQ', 'HK', 'HA'];
  const game = playFixture(cards.map((card, index) => [card, 'H' + (2 + index)]), 'N', 9);
  game.discarded = ['CA', 'DA', 'D8'];
  for (const card of cards.slice(0, 4)) play(game, card);
  assert.deepEqual(getView(game, 1).captured, [[], [], [], [], []]);
  play(game, 'HA');
  const defenderView = getView(game, 1);
  assert.deepEqual(defenderView.captured[4], cards);
  assert.deepEqual(defenderView.scores, [0, 0, 0, 0, 5]);
  assert.deepEqual(defenderView.discarded, []);
  defenderView.captured[4].pop();
  assert.equal(game.captured[4].length, 5);
  for (const card of ['H6', 'H2', 'H3', 'H4', 'H5']) play(game, card);
  const final = getView(game, 1);
  assert.equal(final.phase, 'result');
  assert.deepEqual(final.captured, [[], [], [], [], cards]);
  assert.deepEqual(final.scores, [2, 0, 0, 0, 5]);
  assert.deepEqual(final.discarded, game.discarded);
});

test('60 complete bot games always make 50 legal plays and account for all 20 points', () => {
  for (let run = 0; run < 60; run++) {
    const game = createGame({ firstSeat: run % 5 });
    let turns = 0;
    let plays = 0;
    while (game.phase !== 'result') {
      assert.ok(++turns < 400);
      const action = botAction(game);
      if (action.type === 'play') plays++;
      act(game, action);
    }
    assert.equal(plays, 50);
    assert.equal(game.trickNo, 10);
    assert.equal(game.scores.reduce((a, b) => a + b), 20);
    const buriedPoints = game.discarded.filter(card => /^(S|H|D|C)(10|J|Q|K|A)$/.test(card));
    assert.equal(new Set([...game.captured.flat(), ...buriedPoints]).size, 20);
    for (let seat = 0; seat < 5; seat++) {
      assert.equal(game.captured[seat].length + (seat === game.declarer ? buriedPoints.length : 0), game.scores[seat]);
    }
    assert.deepEqual(game.hands.map(hand => hand.length), [0, 0, 0, 0, 0]);
    assert.equal(game.result.points, game.scores[game.declarer] + (game.scores[game.friend] || 0));
    assert.equal(game.result.won, game.result.points >= game.bid.points);
    for (let seat = 0; seat < 5; seat++) assert.deepEqual(getView(game, seat).result, game.result);
  }
});
