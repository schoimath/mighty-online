import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {botAction, botObservation} from '../engine.js';
import {chooseModelAction} from '../lab/agents.js';
import {rngFor} from '../lab/game.js';
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

function finishWithFriend(session, friendSeat) {
  const submit = action => session.act(session.round.turn, session.revision, action);
  submit({type: 'bid', points: session.rules.minBid, suit: 'H'});
  for (let i = 0; i < 4; i++) submit({type: 'pass'});
  submit({type: 'discard', cards: session.view(session.round.turn).game.hand.slice(0, 3)});
  submit(friendSeat == null ? {type: 'friend', kind: 'none'} :
    {type: 'friend', kind: 'card', card: session.view(friendSeat).game.hand[0]});
  while (session.round.phase === 'play') {
    const [move] = session.view(session.round.turn).game.choices.plays;
    submit({type: 'play', ...move});
  }
  assert.equal(session.round.result.friend, friendSeat);
}

test('AI models follow their configured seats through replacements and rematches', () => {
  const room = fullRoom();
  assert.deepEqual(room.view(0).botModels, Array(5).fill('legacy'));
  const models = ['heuristic', 'random', 'conservative', 'aggressive', 'legacy'];
  room.setBotModels(models);
  models[0] = 'random';
  const snapshot = room.view(1);
  assert.equal(snapshot.botModels[0], 'heuristic');
  snapshot.botModels[4] = 'random';
  assert.equal(room.view(1).botModels[4], 'legacy');
  const revision = room.revision;
  for (const invalid of [[], Array(5), Array(5).fill('other'), 'random']) {
    assert.throws(() => room.setBotModels(invalid), /모델/);
    assert.equal(room.revision, revision);
  }
  room.start();
  assert.throws(() => room.setBotModels(models), /대기실/);
  finishWithFriend(room, 1);
  room.removeGuest(guests[0]);
  assert.equal(room.players[1].modelId, 'random');
  room.start();
  assert.equal(room.players[1].modelId, 'random');
  assert.equal(room.round.turn, 1);
  assert.equal(room.view(2).game.botModels, undefined);
});

test('the main-thread bot uses the seat model for the auction', () => {
  const room = new HostSession('방장', undefined, ['legacy','aggressive','legacy','legacy','legacy']);
  room.start();
  room.act(0, room.revision, {type:'pass'});
  room.round.hands[1] = ['HA','HK','HQ','H6','H5','H4','S2','D3','C4','C5'];
  room.runBot();
  assert.deepEqual(room.round.bid, {suit:'H', points:15, seat:1});
});

test('a worker retry keeps the same random action for the seat', () => {
  const room = new HostSession('방장', undefined, Array(5).fill('random'));
  room.start();
  room.act(0, room.revision, {type:'pass'});
  const seed = 8421;
  const expected = chooseModelAction('random', botObservation(room.round, 1), rngFor(seed));
  room.runBot(undefined, seed);
  const bid = room.round.bidHistory.at(-1);
  assert.equal(bid.seat, 1);
  if (expected.type === 'bid') assert.deepEqual([bid.suit, bid.points], [expected.suit, expected.points]);
  else assert.equal(bid.pass, true);
});

test('the browser worker identifies the model that made each decision', async () => {
  const workerSource = `
    import {parentPort} from 'node:worker_threads';
    globalThis.self = {postMessage: data => parentPort.postMessage(data)};
    await import(${JSON.stringify(new URL('../bot-worker.js', import.meta.url).href)});
    parentPort.on('message', data => self.onmessage({data}));
  `;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(workerSource)));
  try {
    const room = new HostSession('방장');
    room.start();
    const view = botObservation(room.round, room.round.turn), seed = 102;
    for (const modelId of ['random','aggressive']) {
      const reply = once(worker,'message');
      worker.postMessage({revision:17, modelId, seed, view});
      const [packet] = await reply;
      assert.deepEqual(packet, {revision:17, modelId, action:chooseModelAction(modelId, view, rngFor(seed))});
    }
  } finally {
    await worker.terminate();
  }
});

test('host and guests choose open seats without changing connection identity', () => {
  const room = new HostSession('방장');
  room.addGuest('a', '가');
  room.addGuest('b', '나');
  const clickedAt = room.revision;
  assert.equal(room.moveSeat(null, 4, clickedAt), true);
  assert.equal(room.hostSeat, 4);
  assert.equal(room.view(1).hostSeat, 4);
  assert.equal(room.players[0], null);
  assert.equal(room.moveSeat('a', 0, room.revision), true);
  assert.equal(room.seatFor('a'), 0);
  assert.equal(room.view(0).players[0].name, '가');

  const before = room.view(4);
  assert.throws(() => room.moveSeat('b', 3, clickedAt), /다시 선택/);
  assert.throws(() => room.moveSeat('b', 0, room.revision), /다른 참가자/);
  assert.throws(() => room.moveSeat(null, 2, room.revision), /다른 참가자/);
  assert.throws(() => room.moveSeat('disconnected', 3, room.revision), /연결/);
  for (const invalid of [-1, 5, 1.5, '1', null]) {
    assert.throws(() => room.moveSeat('b', invalid, room.revision), /유효하지/);
  }
  assert.equal(room.moveSeat('b', 2, room.revision), false);
  assert.deepEqual(room.view(4), before);
  assert.equal(room.seatFor('b'), 2);

  const sharedRevision = room.revision;
  room.moveSeat('b', 3, sharedRevision);
  assert.throws(() => room.moveSeat('a', 3, sharedRevision));
  assert.equal(room.seatFor('a'), 0);
  assert.equal(room.seatFor('b'), 3);
  assert.equal(room.addGuest('c', '다'), null);
  assert.equal(room.seatFor('c'), 1);
});

test('chosen seats determine hands, turns, disconnect replacements and rematches', () => {
  const room = new HostSession('방장');
  room.addGuest('a', '첫 손님');
  room.moveSeat(null, 3, room.revision);
  room.moveSeat('a', 0, room.revision);
  room.start();
  const guest = room.view(room.seatFor('a'));
  const host = room.view(room.hostSeat);
  assert.deepEqual(guest.players.map(p => p.bot), [false, true, true, false, true]);
  assert.equal(guest.game.turn, 0);
  assert.equal(guest.game.seat, 0);
  assert.equal(host.game.seat, 3);
  assert.ok(guest.game.hand.every(c => !host.game.hand.includes(c)));
  assert.throws(() => room.moveSeat('a', 2, room.revision), /대기실/);
  assert.throws(() => room.act(room.hostSeat, room.revision, {type:'pass'}), /차례/);
  room.act(guest.seat, room.revision, {type:'bid', points:14, suit:'H'});
  assert.equal(room.round.bidHistory[0].name, '첫 손님');
  room.removeGuest('a');
  assert.equal(room.players[0].bot, true);
  assert.equal(room.seatFor('a'), -1);
  assert.equal(room.players[3].name, '방장');
  while (room.round.phase !== 'result') {
    if (room.botTurn) room.runBot();
    else room.act(room.hostSeat, room.revision, botAction(room.round));
  }
  const nextBidder = room.round.result.friend ?? room.round.result.declarer;
  assert.throws(() => room.moveSeat(null, 1, room.revision), /대기실/);
  room.returnToRoom();
  assert.deepEqual(room.players.map(p => p?.name ?? null), [null, null, null, '방장', null]);
  assert.equal(room.addGuest('new', '다음 손님'), null);
  room.moveSeat('new', 1, room.revision);
  room.start();
  assert.equal(room.view(1).game.turn, nextBidder);
  assert.equal(room.view(1).hostSeat, 3);
});

test('a full room can exchange seats by mutual consent while other pairs make independent requests', () => {
  const room = fullRoom();
  const before = room.view(0).players;
  const oldRevision = room.revision;
  room.requestSeatSwap(null, 1, oldRevision);
  assert.deepEqual(room.view(1).swap, {from: 0, to: 1});
  const requesterView = room.view(0);
  requesterView.swap.to = 2;
  assert.equal(room.view(0).swap.to, 1);
  assert.equal(room.view(2).swap, null);
  assert.deepEqual(room.view(0).players, before);
  assert.throws(() => room.answerSeatSwap(null, true, room.revision));
  assert.throws(() => room.answerSeatSwap(guests[1], true, room.revision));
  assert.throws(() => room.cancelSeatSwap(guests[0], room.revision));
  assert.throws(() => room.requestSeatSwap(guests[1], 1, oldRevision));
  assert.throws(() => room.requestSeatSwap(guests[1], 1, room.revision));
  assert.throws(() => room.requestSeatSwap(guests[0], 2, room.revision));
  assert.throws(() => room.answerSeatSwap(guests[0], 'true', room.revision));
  const incomingRevision = room.revision;
  room.requestSeatSwap(guests[1], 3, room.revision);
  assert.deepEqual(room.view(2).swap, {from: 2, to: 3});
  assert.throws(() => room.answerSeatSwap(guests[0], true, incomingRevision));
  room.answerSeatSwap(guests[0], true, room.revision);
  assert.equal(room.hostSeat, 1);
  assert.equal(room.seatFor(guests[0]), 0);
  assert.equal(room.view(0).players[0].name, before[1].name);
  assert.equal(room.view(0).swap, null);
  assert.equal(room.view(1).swap, null);
  assert.deepEqual(room.view(2).swap, {from: 2, to: 3});
  room.answerSeatSwap(guests[2], true, room.revision);
  assert.equal(room.seatFor(guests[1]), 3);
  assert.equal(room.seatFor(guests[2]), 2);
  assert.equal(room.hostSeat, 1);
  room.requestSeatSwap(guests[2], 1, room.revision);
  room.answerSeatSwap(null, true, room.revision);
  assert.equal(room.hostSeat, 2);
  assert.equal(room.seatFor(guests[2]), 1);
});

test('declining, canceling, moving, leaving or starting settles pending seat requests', () => {
  const room = new HostSession('방장');
  room.addGuest('a', '손님');
  assert.throws(() => room.requestSeatSwap(null, 0, room.revision));
  assert.throws(() => room.requestSeatSwap(null, 2, room.revision));
  room.requestSeatSwap('a', 0, room.revision);
  room.answerSeatSwap(null, false, room.revision);
  assert.equal(room.seatFor('a'), 1);
  assert.equal(room.hostSeat, 0);
  assert.equal(room.view(1).swap, null);
  room.requestSeatSwap('a', 0, room.revision);
  room.cancelSeatSwap('a', room.revision);
  assert.equal(room.view(0).swap, null);
  room.requestSeatSwap('a', 0, room.revision);
  room.moveSeat(null, 2, room.revision);
  assert.equal(room.view(1).swap, null);
  room.requestSeatSwap(null, 1, room.revision);
  const beforeExit = room.revision;
  room.removeGuest('a');
  room.addGuest('b', '새 손님');
  assert.equal(room.seatFor('b'), 0);
  room.moveSeat('b', 1, room.revision);
  assert.equal(room.view(1).swap, null);
  assert.throws(() => room.answerSeatSwap('b', true, beforeExit));
  assert.throws(() => room.answerSeatSwap('b', true, room.revision));
  room.requestSeatSwap('b', 2, room.revision);
  room.start();
  assert.equal(room.view(1).swap, null);
  assert.throws(() => room.answerSeatSwap(null, true, room.revision), /대기실/);
  assert.equal(room.hostSeat, 2);
  assert.equal(room.seatFor('b'), 1);
});

test('host room rules are shared before play, frozen for a round and reusable on replay', () => {
  const session = new HostSession('방장');
  session.addGuest('guest', '친구');
  const original = session.view(1);
  original.rules.minBid = 13;
  assert.equal(session.view(0).rules.minBid, 14);
  const rules = {minBid: 20, allowFirstFriend: false, allowFirstJokerCall: true, allowLastJoker: true};
  session.setRules(rules);
  session.setRules({minBid: 19});
  assert.equal(rules.minBid, 20);
  const expected = {...rules, minBid: 19};
  const lobby = session.view(1);
  assert.equal(lobby.revision, original.revision + 2);
  assert.deepEqual(lobby.rules, expected);
  assert.throws(() => session.setRules({minBid: 21}));
  assert.deepEqual(session.view(1), lobby);
  session.start();
  assert.deepEqual(session.view(1).game.rules, expected);
  const live = session.view(1);
  assert.throws(() => session.setRules({minBid: 13}));
  assert.deepEqual(session.view(1), live);
  session.act(0, session.revision, {type: 'bid', points: 19, suit: 'H'});
  session.act(1, session.revision, {type: 'pass'});
  session.removeGuest('guest');
  while (session.round.phase !== 'result') {
    if (session.botTurn) session.runBot();
    else session.act(0, session.revision, botAction(session.round, 0));
  }
  session.returnToRoom();
  assert.deepEqual(session.view(0).rules, expected);
  session.start();
  assert.deepEqual(session.view(0).game.rules, expected);
});

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

  session.act(actingSeat, initial.revision, {type: 'bid', points: 14, suit: 'H'});
  const next = session.view(0);
  assert.ok(next.revision > initial.revision);
  assert.throws(() => session.act(next.game.turn, initial.revision, {type: 'pass'}));
  assert.deepEqual(session.view(0), next);
});

test('a direct rematch deals to the same connected seats and opens a fresh auction', () => {
  const session = fullRoom();
  session.setRules({minBid: 15, allowLastJoker: true});
  session.start();
  finishWithFriend(session, 3);
  const oldRevision = session.revision;
  const before = session.view(2);
  session.start();
  const after = session.view(2);
  assert.equal(after.game.phase, 'bid');
  assert.equal(after.game.turn, 3);
  assert.equal(after.game.lastTrick, null);
  assert.deepEqual(after.game.bidHistory, []);
  assert.deepEqual(after.game.counts, [10, 10, 10, 10, 10]);
  assert.deepEqual(after.rules, before.rules);
  assert.deepEqual(after.players, before.players);
  assert.equal(session.seatFor(guests[1]), 2);
  assert.throws(() => session.act(3, oldRevision, {type:'pass'}));
  session.act(3, after.revision, {type:'pass'});
});

test('the previous friend opens after a lobby swap, and a solo declarer opens the next round', () => {
  const room = fullRoom();
  room.start();
  finishWithFriend(room, 2);
  room.returnToRoom();
  room.requestSeatSwap(guests[1], 4, room.revision);
  room.answerSeatSwap(guests[3], true, room.revision);
  room.start();
  assert.equal(room.view(0).game.turn, 4);
  finishWithFriend(room, null);
  room.start();
  assert.equal(room.view(0).game.turn, 4);
  finishWithFriend(room, 0);
  room.returnToRoom();
  room.requestSeatSwap(null, 4, room.revision);
  room.answerSeatSwap(guests[1], true, room.revision);
  room.start();
  assert.equal(room.view(room.hostSeat).game.turn, 4);
});

test('a departed friend leaves the opening bid at their latest seat', () => {
  const room = fullRoom();
  room.start();
  finishWithFriend(room, 1);
  room.returnToRoom();
  room.removeGuest(guests[3]);
  room.moveSeat(guests[0], 4, room.revision);
  room.removeGuest(guests[0]);
  room.start();
  assert.equal(room.view(0).game.turn, 4);
  assert.equal(room.botTurn, true);
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
  submit({type: 'bid', points: 14, suit: 'H'});
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
  assert.equal(final.scores[declarer], null);
  assert.equal(final.scores[friend], null);
  const defense = final.scores.filter(score => score !== null);
  assert.equal(defense.reduce((sum, score) => sum + score, final.result.points), 20);
  session.returnToRoom();
  assert.equal(session.view(0).game, null);
});
