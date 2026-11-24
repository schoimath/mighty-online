import test from 'node:test';
import assert from 'node:assert/strict';
import { HostSession } from '../session.js';

const guests = ['conn-amber', 'conn-blue', 'conn-coral', 'conn-denim'];

function fullRoom() {
  const session = new HostSession('방장');
  guests.forEach((id, index) => {
    assert.equal(session.addGuest(id, '친구 ' + (index + 1)), null);
    assert.equal(session.seatFor(id), index + 1);
  });
  return session;
}

test('each connection has one seat, one private hand, and a revision-checked turn', () => {
  const session = fullRoom();
  assert.equal(typeof session.addGuest('conn-extra', '다섯 번째 손님'), 'string');
  assert.equal(session.seatFor('conn-extra'), -1);
  session.start();

  const views = Array.from({length: 5}, (_, seat) => session.view(seat));
  const hands = views.map(view => view.game.hand);
  assert.equal(new Set(hands.flat()).size, 50);
  for (const [seat, view] of views.entries()) {
    assert.equal(view.seat, seat);
    assert.equal(view.game.seat, seat);
    assert.equal(view.game.hand.length, 10);
    assert.equal(view.players.length, 5);
    const payload = JSON.stringify(view);
    for (const id of guests) assert.ok(!payload.includes(id));
    for (const card of hands.filter((_, other) => other !== seat).flat()) {
      assert.ok(!payload.includes(JSON.stringify(card)), 'another player’s card leaked: ' + card);
    }
  }

  const initial = views[0];
  const actingSeat = initial.game.turn;
  const other = guests.find(id => session.seatFor(id) !== actingSeat);
  const forgedAction = {type: 'pass', seat: actingSeat};
  assert.throws(() => session.act(session.seatFor(other), initial.revision, forgedAction));
  assert.deepEqual(session.view(0), initial);

  session.act(actingSeat, initial.revision, {type: 'bid', points: 13, suit: 'H'});
  const next = session.view(0);
  assert.ok(next.revision > initial.revision);
  assert.throws(() => session.act(next.game.turn, initial.revision, {type: 'pass'}));
  assert.deepEqual(session.view(0), next);
});

test('auction entries keep the bidder name after a bot takes the seat', () => {
  const session = fullRoom();
  session.start();
  session.act(0, session.revision, {type: 'pass'});
  session.act(1, session.revision, {type: 'bid', suit: 'H', points: 18, name: '다른 이름'});
  session.removeGuest(guests[0]);
  const view = session.view(0);
  assert.equal(view.players[1].bot, true);
  assert.equal(view.game.bidHistory[0].name, '방장');
  assert.equal(view.game.bidHistory[1].name, '친구 1');
  session.removeGuest(guests[1]);
  session.runBot();
  assert.equal(session.view(0).game.bidHistory.at(-1).name, session.players[2].name);
});

test('a full room completes ten tricks when a guest disconnects during play', () => {
  const session = fullRoom();
  session.start();
  function submit(action) {
    const {game, revision} = session.view(0);
    session.act(game.turn, revision, action);
  }
  submit({type: 'bid', points: 13, suit: 'H'});
  for (let i = 0; i < 4; i++) submit({type: 'pass'});

  const declarer = session.view(0).game.turn;
  const friend = (declarer + 1) % 5;
  const discard = session.view(declarer).game.hand.slice(0, 3);
  submit({type: 'discard', cards: discard});
  assert.deepEqual(session.view(declarer).game.discarded, discard);
  assert.deepEqual(session.view(friend).game.discarded, []);
  submit({type: 'friend', kind: 'card', card: session.view(friend).game.hand[0]});
  assert.equal(session.view(friend).game.selfRole, 'friend');
  assert.equal(session.view(declarer).game.friend, null);

  const disconnected = guests[2];
  const bot = session.seatFor(disconnected);
  session.removeGuest(disconnected);
  assert.equal(session.seatFor(disconnected), -1);
  assert.equal(session.view(0).players[bot].bot, true);
  let botPlays = 0;
  for (let play = 0; play < 50; play++) {
    const {game} = session.view(0);
    assert.equal(game.phase, 'play');
    if (session.botTurn) {
      assert.equal(game.turn, bot);
      session.runBot();
      botPlays++;
    } else {
      const choices = session.view(game.turn).game.choices.plays;
      submit({type: 'play', ...choices[0]});
    }
  }
  assert.equal(botPlays, 10);
  const final = session.view(0).game;
  assert.equal(final.phase, 'result');
  assert.equal(final.lastTrick.number, 10);
  assert.equal(final.result.friend, friend);
  assert.equal(final.scores.reduce((sum, score) => sum + score, 0), 20);
  session.returnToRoom();
  assert.equal(session.view(0).game, null);
});
