import test from 'node:test';
import assert from 'node:assert/strict';
import {HostSession} from '../session.js';
import {analyzeSetting} from '../table-claim.js';

function makeRoom(limit) {
  const room = new HostSession('방장', undefined, Array(5).fill('heuristic'), limit);
  for (let seat = 1; seat < 5; seat++) room.addGuest(seat, '손님' + seat);
  return room;
}

function openHand(room) {
  const submit = action => room.act(room.round.turn, room.revision, action);
  submit({type:'bid', suit:'H', points:14});
  for (let i = 0; i < 4; i++) submit({type:'pass'});
  submit({type:'discard', cards:room.view(room.round.turn).game.hand.slice(0, 3)});
  submit({type:'friend', kind:'none'});
}

function finishByClaim(room) {
  const job = room.act(room.round.turn, room.revision, {type:'claim'});
  const verdict = analyzeSetting(job);
  assert.equal(room.finishClaim(job, verdict), true);
  assert.equal(room.finishClaim(job, verdict), false);
}

test('the goal is locked after the first deal and the tenth settlement closes the match exactly once', () => {
  const room = makeRoom(10);
  const departedId = room.players[4].memberId;
  for (let n = 1; n <= 10; n++) {
    room.start();
    openHand(room);
    if (n === 1) {
      while (room.round.phase === 'play') {
        const seat = room.round.turn;
        const move = room.view(seat).game.choices.plays[0];
        room.act(seat, room.revision, {type:'play', ...move});
      }
      room.returnToRoom();
      assert.throws(() => room.setRoundLimit(20));
    } else {
      if (n === 10) room.removeGuest(4);
      finishByClaim(room);
    }
    const board = room.view(0).scoreboard;
    assert.equal(board.rounds, n);
    assert.equal(board.roundLimit, 10);
    assert.equal(board.complete, n === 10);
  }

  const final = room.view(0).scoreboard;
  assert.throws(() => room.start(), /목표 판수/);
  for (let seat = 1; seat < 5; seat++) assert.deepEqual(room.view(seat).scoreboard, final);
  const ranked = final.members.filter(member => member.rounds > 0);
  assert.equal(ranked.length, 5);
  assert.ok(ranked.every(member => member.rounds === 10));
  for (const member of ranked) {
    assert.equal(member.rank, 1 + ranked.filter(other => other.total > member.total).length);
  }
  assert.ok(new Set(ranked.map(member => member.rank)).size < ranked.length);
  assert.equal(final.members.find(member => member.id === departedId).seat, null);
  assert.equal(final.members.find(member => member.seat === 4).rank, null);

  const present = room.players.filter(player => !player.bot).map(player => player.memberId);
  room.returnToRoom();
  const fresh = room.view(0).scoreboard;
  assert.equal(fresh.rounds, 0);
  assert.equal(fresh.complete, false);
  assert.equal(fresh.roundLimit, 10);
  assert.deepEqual(fresh.members.map(member => member.id), present);
  assert.ok(fresh.members.every(member => member.total === 0 && member.lastDelta === null && member.rank === null));
  room.setRoundLimit(20);
  room.start();
  assert.equal(room.round.turn, 0);
});

test('20 rounds and unlimited rounds count settled hands and skip all-pass redeals', () => {
  for (const limit of [20, undefined]) {
    const room = makeRoom(limit);
    room.start();
    for (let i = 0; i < 5; i++) room.act(room.round.turn, room.revision, {type:'pass'});
    assert.equal(room.view(0).scoreboard.rounds, 0);
    for (let n = 1; n <= (limit ?? 21); n++) {
      if (n > 1) room.start();
      openHand(room);
      finishByClaim(room);
      const board = room.view(1).scoreboard;
      assert.equal(board.rounds, n);
      assert.equal(board.complete, n === limit);
    }
    if (limit) assert.throws(() => room.start());
    else assert.doesNotThrow(() => room.start());
  }
  for (const invalid of [0, 1, 15, '10']) assert.throws(() => makeRoom(invalid));
});
