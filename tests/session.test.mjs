import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {botAction, botObservation} from '../engine.js';
import {rngFor} from '../lab/game.js';
import {MODEL_CATALOG, decideTableTurn} from '../lab/table-agents.js';
import {contractSearchAction} from '../lab/contract-search.js';
import { HostSession } from '../session.js';
import {settlements} from '../table-scoring.js';

const guests = ['conn-amber', 'conn-blue', 'conn-coral', 'conn-denim'];

function fullRoom() {
  const session = new HostSession('방장');
  guests.forEach((id, index) => {
    assert.equal(session.addGuest(id, '친구 ' + (index + 1)), null);
    assert.equal(session.seatFor(id), index + 1);
  });
  return session;
}

test('the selected pace follows the host, seated guests and spectators into the hand', () => {
  const room = new HostSession('방장', undefined, undefined, 10, {publicRoom:true});
  assert.equal(room.pace, 'normal');
  room.addGuest('guest', '친구', 'play');
  room.addGuest('observer', '관전자', 'watch');
  room.setPace('fast');
  assert.equal(room.plannedTable().pace, 'fast');
  room.start();
  for (const view of [room.hostView(), room.viewFor('guest'), room.viewFor('observer')]) {
    assert.equal(view.pace, 'fast');
  }
  const revision = room.revision;
  room.setPace('slow');
  assert.equal(room.viewFor('observer').pace, 'slow');
  assert.equal(room.revision, revision, 'a local pace change preserves an in-flight play');
  room.act(room.round.turn, revision, {type:'bid', points:14, suit:'H'});
  assert.equal(room.round.bid.suit, 'H');
});

function finishWithFriend(session, friendSeat) {
  const submit = action => session.botTurn ? session.runBot(action) : session.act(session.round.turn, session.revision, action);
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

test('members start at zero and keep their own cumulative scores after a lobby seat swap and rematches', () => {
  const room = fullRoom();
  const board = () => room.view(0).scoreboard;
  const opening = board();
  assert.equal(opening.rounds, 0);
  assert.deepEqual(opening.members.map(m => [m.seat,m.total,m.rounds,m.lastDelta]), [0,1,2,3,4].map(seat => [seat,0,0,null]));
  const ids = opening.members.map(m => m.id);
  room.start();
  assert.deepEqual(board(), opening);
  finishWithFriend(room, 2);
  const first = settlements(room.round.result, room.round.bid.suit);
  const expected = new Map(ids.map((id, seat) => [id, first[seat]]));
  const firstBoard = board();
  assert.equal(firstBoard.rounds, 1);
  assert.deepEqual(firstBoard.members.map(m => m.total), first);
  assert.deepEqual(firstBoard.members.map(m => m.lastDelta), first);
  assert.deepEqual(firstBoard.members.map(m => m.lastSeat), [0,1,2,3,4]);
  for (let seat = 0; seat < 5; seat++) assert.deepEqual(room.view(seat).scoreboard, firstBoard);
  assert.throws(() => room.act(1,room.revision-1,{type:'play',card:'H2'}));
  assert.throws(() => room.act(1,room.revision,{type:'play',card:'H2'}));
  assert.deepEqual(board(), firstBoard);
  board().members[0].total = 9999;
  assert.deepEqual(board(), firstBoard);
  room.returnToRoom();
  room.requestSeatSwap(null, 2, room.revision);
  room.answerSeatSwap(guests[1], true, room.revision);
  assert.deepEqual(board().members.map(m => m.id), [ids[2],ids[1],ids[0],ids[3],ids[4]]);
  room.start();
  const secondSeats = board().members;
  assert.ok(secondSeats.every(m => m.total === expected.get(m.id)));
  finishWithFriend(room, null);
  const second = settlements(room.round.result, room.round.bid.suit);
  for (const row of secondSeats) expected.set(row.id,expected.get(row.id)+second[row.seat]);
  assert.equal(board().rounds, 2);
  for (const row of board().members) {
    assert.equal(row.total,expected.get(row.id));
    assert.equal(row.rounds,2);
    assert.equal(row.lastDelta,second[row.seat]);
  }
  const finished = board();
  room.start();
  assert.deepEqual(board(),finished);
});

test('a replacement finishes for the original member, then keeps a separate score as a returning AI', () => {
  const room = fullRoom();
  const board = () => room.view(0).scoreboard;
  const absentId = board().members[1].id;
  const byId = id => board().members.find(m => m.id === id);
  room.start();
  room.removeGuest(guests[0]);
  const botId = room.players[1].memberId;
  assert.notEqual(absentId, botId);
  finishWithFriend(room, 1);
  const originalPay = settlements(room.round.result,room.round.bid.suit)[1];
  assert.deepEqual([byId(absentId).seat,byId(absentId).lastSeat,byId(absentId).rounds,byId(absentId).total],[null,1,1,originalPay]);
  assert.deepEqual([byId(botId).seat,byId(botId).lastSeat,byId(botId).rounds,byId(botId).total],[1,null,0,0]);
  room.start();
  finishWithFriend(room, null);
  const botPay = settlements(room.round.result,room.round.bid.suit)[1];
  assert.deepEqual([byId(absentId).total,byId(absentId).lastDelta],[originalPay,null]);
  assert.deepEqual([byId(botId).total,byId(botId).lastDelta],[botPay,botPay]);
  room.returnToRoom();
  assert.equal(byId(botId).seat,null);
  room.setBotModels(Array(5).fill('heuristic'));
  room.start();
  assert.equal(room.players[1].memberId,botId);
  assert.equal(byId(botId).total,botPay);
  finishWithFriend(room, 0);
  room.returnToRoom();
  assert.equal(room.addGuest('new-connection','친구 1'),null);
  const newId = room.players[1].memberId;
  assert.notEqual(newId,absentId);
  assert.deepEqual([byId(newId).total,byId(newId).rounds,byId(newId).lastDelta],[0,0,null]);
  assert.equal(byId(absentId).total,originalPay);
  assert.equal(board().members.reduce((sum,m) => sum + m.total,0),0);
});

test('each seat independently draws from just the three playable models when creating a room', t => {
  const draws = [0, .34, .99, .8, .45];
  const random = t.mock.method(Math, 'random', () => draws.shift());
  const room = new HostSession('방장');
  random.mock.restore();
  assert.deepEqual(draws, []);
  assert.deepEqual(MODEL_CATALOG.map(m => m.id), ['contract_search','recurrent_balanced','heuristic']);
  const expected = ['contract_search','recurrent_balanced','heuristic','heuristic','recurrent_balanced'];
  assert.equal(room.view(0).modelChoice, 'random');
  assert.deepEqual(room.view(0).botModels, expected);
  assert.deepEqual(room.view(3).botModels, expected);
});

test('a random model choice survives matching draws, room updates and host handoff', t => {
  const room = new HostSession('방장', undefined, undefined, 10, {modelChoice:'heuristic', publicRoom:true});
  room.addGuest('guest', '친구', 'play');
  assert.equal(room.viewFor('guest').modelChoice, 'heuristic');
  assert.deepEqual(room.plannedTable().models, Array(5).fill('heuristic'));
  const random = t.mock.method(Math, 'random', () => 0);
  room.setModelChoice('random');
  room.setModelChoice('random');
  const next = HostSession.takeOver(room.handoffState(), 'guest');
  assert.equal(random.mock.callCount(), 5);
  random.mock.restore();
  assert.equal(next.hostView().modelChoice, 'random');
  assert.deepEqual(next.plannedTable().models, Array(5).fill('contract_search'));
  next.setModelChoice('recurrent_balanced');
  assert.deepEqual(next.plannedTable().models, Array(5).fill('recurrent_balanced'));
  next.start();
  assert.ok(next.players.filter(player => player.bot).every(player => player.modelId === 'recurrent_balanced'));
});

test('AI models follow their configured seats through replacements and rematches', () => {
  const room = fullRoom();
  const models = ['heuristic', 'recurrent_balanced', 'contract_search', 'heuristic', 'contract_search'];
  room.setBotModels(models);
  models[0] = 'recurrent_balanced';
  const snapshot = room.view(1);
  assert.equal(snapshot.botModels[0], 'heuristic');
  snapshot.botModels[4] = 'heuristic';
  assert.equal(room.view(1).botModels[4], 'contract_search');
  const revision = room.revision;
  for (const invalid of [[], Array(5), Array(5).fill('other'), Array(5).fill('legacy'), 'random']) {
    assert.throws(() => room.setBotModels(invalid), /모델/);
    assert.equal(room.revision, revision);
  }
  room.start();
  assert.throws(() => room.setBotModels(models), /대기실/);
  finishWithFriend(room, 1);
  room.removeGuest(guests[0]);
  assert.equal(room.players[1].modelId, 'recurrent_balanced');
  room.start();
  assert.equal(room.players[1].modelId, 'recurrent_balanced');
  assert.equal(room.round.turn, 1);
  assert.equal(room.view(2).game.botModels, undefined);
});

test('the main-thread bot uses the seat model for the auction', () => {
  const room = new HostSession('방장', undefined, ['heuristic','recurrent_balanced','contract_search','heuristic','heuristic']);
  room.start();
  room.act(0, room.revision, {type:'pass'});
  room.round.hands[1] = ['SA','SK','S10','H9','H8','DK','CK','C9','C6','C2'];
  // The search model bids clubs on this hand; the balanced GRU passes.
  const request = room.botRequest(3);
  assert.deepEqual(decideTableTurn({...request, modelId:'contract_search'}).action, {type:'bid', points:14, suit:'C'});
  room.runBot(undefined, 3);
  const last = room.round.bidHistory.at(-1);
  assert.deepEqual([last.seat, last.pass], [1, true]);
});

test('a worker retry uses the same sampled deals for the post-kitty contract', () => {
  const room = new HostSession('방장', undefined, Array(5).fill('contract_search'));
  room.start();
  room.act(0, room.revision, {type:'pass'});
  room.runBot({type:'bid', suit:'H', points:14});
  for (let i = 2; i < 5; i++) room.runBot({type:'pass'});
  const seed = 8421;
  const view = botObservation(room.round, 1);
  const expected = contractSearchAction(view, rngFor(seed));
  assert.deepEqual(decideTableTurn(room.botRequest(seed)).action, expected);
  room.runBot(undefined, seed);
  assert.deepEqual(room.round.discarded, expected.cards);
  assert.deepEqual(room.round.bid, {...expected.contract, seat:1});
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
    for (const {id:modelId} of MODEL_CATALOG) {
      const reply = once(worker,'message');
      worker.postMessage({revision:17, modelId, seed, view});
      const [packet] = await reply;
      assert.deepEqual(packet, {revision:17, modelId, ...decideTableTurn({modelId, view, seed})});
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

test('only the declarer sees which three cards arrived during the exchange', () => {
  const session = fullRoom();
  session.start();
  const submit = action => session.act(session.round.turn, session.revision, action);
  submit({type: 'pass'});
  const declarer = session.round.turn;
  const original = session.view(declarer).game;
  assert.equal('incomingCards' in original, false);
  submit({type: 'bid', points: 14, suit: 'D'});
  while (session.round.phase === 'bid') submit({type: 'pass'});

  const exchange = session.view(declarer).game;
  const received = exchange.hand.filter(card => !original.hand.includes(card));
  assert.equal(received.length, 3);
  assert.deepEqual(new Set(exchange.incomingCards), new Set(received));
  for (let seat = 0; seat < 5; seat++) {
    if (seat === declarer) continue;
    const packet = session.view(seat);
    assert.equal('incomingCards' in packet.game, false);
    for (const card of received) assert.ok(!JSON.stringify(packet).includes(JSON.stringify(card)));
  }
  exchange.incomingCards.pop();
  assert.equal(session.view(declarer).game.incomingCards.length, 3);
  submit({type: 'discard', cards: original.hand.slice(0, 3)});
  assert.equal('incomingCards' in session.view(declarer).game, false);
});

function jokerRoom(t, seed) {
  const room = new HostSession('방장', {allowFirstJokerCall:true});
  room.moveSeat(null, 1, room.revision);
  room.addGuest('declarer', '주공');
  const random = rngFor(seed);
  const shuffle = t.mock.method(crypto, 'getRandomValues', array => {
    array[0] = Math.floor(random() * 2 ** 32);
    return array;
  });
  room.start();
  shuffle.mock.restore();
  const step = action => room.botTurn ? room.runBot(action) : room.act(room.round.turn, room.revision, action);
  const checkJoker = expected => {
    for (let seat = 0; seat < 5; seat++) assert.equal(room.view(seat).game.jokerPlayed, expected);
  };
  checkJoker(false);
  step({type:'bid', points:14, suit:'N'});
  for (let i = 0; i < 4; i++) step({type:'pass'});
  const startPlay = buried => {
    step({type:'discard', cards:buried});
    step({type:'friend', kind:'none'});
  };
  const firstPlay = () => step({type:'play', ...room.view(room.round.turn).game.choices.plays[0]});
  return {room, step, checkJoker, startPlay, firstPlay};
}

test('the fifth card counts as a public Joker even when the declarer covers the trick', t => {
  const {room, step, checkJoker, startPlay, firstPlay} = jokerRoom(t, 38);
  startPlay(room.view(0).game.hand.filter(card => card !== 'SA' && card !== 'C3').slice(0,3));
  step({type:'play', card:'SA'});
  for (let i = 0; i < 3; i++) firstPlay();
  checkJoker(false);
  step({type:'play', card:'JK'});
  checkJoker(true);
  assert.deepEqual(room.view(4).game.lastTrick.cards, []);
  assert.equal(room.view(0).game.trick.length, 0);
  const plays = room.view(0).game.choices.plays;
  const raw = botObservation(room.round, 0);
  assert.ok(raw.choices.plays.some(move => move.jokerCall));
  for (const {id:modelId} of MODEL_CATALOG) {
    const request = {modelId, seed:38, view:raw};
    const actual = decideTableTurn(request);
    assert.deepEqual(actual, decideTableTurn({...request, view:{...raw, jokerPlayed:true, choices:{...raw.choices, plays}}}));
    assert.ok(!actual.action.jokerCall);
  }
  assert.deepEqual(plays.filter(p => p.card === 'C3'), [{card:'C3'}]);
  const other = plays.find(p => p.card !== 'C3');
  assert.throws(() => step({type:'play', ...other, jokerCall:true}), /낼 수 있는 카드/);

  room.removeGuest('declarer');
  const request = room.botRequest(1);
  assert.equal(request.view.jokerPlayed, true);
  assert.deepEqual(request.view.choices.plays.filter(p => p.card === 'C3'), [{card:'C3'}]);
  step({type:'play', card:'C3', jokerCall:true}); // A previously legal declaration from an older client.
  assert.deepEqual(room.view(0).game.trick[0], {seat:0, card:'C3'});
  while (room.round.phase === 'play') firstPlay();
  checkJoker(true);
  room.start();
  checkJoker(false);
});

test('a Joker responding to a live call is public immediately and preserves that declaration', t => {
  const {room, step, checkJoker, startPlay} = jokerRoom(t, 11);
  startPlay(room.view(0).game.hand.filter(card => card !== 'C3').slice(0,3));
  step({type:'play', card:'C3', jokerCall:true});
  checkJoker(false);
  step({type:'play', card:'JK'});
  checkJoker(true);
  assert.deepEqual(room.view(3).game.trick[0], {seat:0, card:'C3', jokerCall:true});
});

test('a Joker privately picked up and buried never becomes publicly played', t => {
  const {room, checkJoker, startPlay, firstPlay} = jokerRoom(t, 3);
  assert.ok(room.view(0).game.incomingCards.includes('JK'));
  checkJoker(false);
  startPlay(['JK', ...room.view(0).game.hand.filter(card => card !== 'JK').slice(0,2)]);
  while (room.round.phase === 'play') {
    checkJoker(false);
    firstPlay();
  }
  checkJoker(false);
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
