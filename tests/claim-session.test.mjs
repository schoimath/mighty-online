import test from 'node:test';
import assert from 'node:assert/strict';
import {HostSession} from '../session.js';
import {createGame} from '../table-deal.js';
import {canSweepRemaining} from '../table-claim.js';
import {rngFor} from '../lab/game.js';
import {settlements} from '../table-scoring.js';

function openAsGuest() {
  const room = new HostSession('방장', undefined, Array(5).fill('heuristic'));
  for (let i = 1; i < 5; i++) room.addGuest('guest' + i, '손님' + i);
  room.start();
  room.round = createGame({random:rngFor(41)});
  const submit = action => room.act(room.round.turn, room.revision, action);
  submit({type:'pass'});
  submit({type:'bid', suit:'N', points:20});
  for (let i = 0; i < 3; i++) submit({type:'pass'});
  submit({type:'discard', cards:room.view(1).game.hand.slice(0,3)});
  submit({type:'friend', kind:'none'});
  return room;
}

test('a guest claim is adjudicated on the host, survives a disconnect and settles only once', () => {
  const room = openAsGuest();
  const member = room.players[1].memberId;
  const revision = room.revision;
  assert.equal(room.view(1).game.choices.canDeclareSetting, true);
  assert.throws(() => room.act(0, revision, {type:'claim'}));
  const job = room.act(1, revision, {type:'claim', success:true, hands:[]});
  assert.deepEqual(job.hands, room.round.hands);
  assert.equal(canSweepRemaining(job), false);
  const waiting = room.view(0);
  assert.equal(waiting.game.claimPending, true);
  assert.equal(waiting.game.turn, null);
  assert.equal(waiting.game.hands, undefined);
  assert.deepEqual(waiting.game.hand, room.round.hands[0]);
  assert.deepEqual(room.view(1).game.choices.plays, []);
  assert.throws(() => room.act(1, revision, {type:'claim'}));
  assert.throws(() => room.act(1, room.revision, {type:'play',card:job.hands[1][0]}));
  assert.equal(room.finishClaim(structuredClone(job), true), false);
  room.removeGuest('guest1');
  assert.equal(room.botTurn, false);
  assert.equal(room.finishClaim(job, false), true);
  assert.equal(room.finishClaim(job, false), false);
  assert.equal(room.view(0).game.result.setting.success, false);
  const board = room.view(0).scoreboard;
  assert.equal(board.rounds, 1);
  assert.equal(board.members.find(m => m.id === member).total, settlements(room.round.result,'N')[1]);
  assert.equal(board.members.reduce((sum, m) => sum + m.total, 0), 0);
  room.start();
  assert.equal(room.view(0).scoreboard.rounds, 1);
  assert.equal(room.finishClaim(job, true), false);
});

test('an interrupted verification releases the same hand without any score or penalty', () => {
  const room = openAsGuest();
  const before = room.view(1).game;
  const job = room.act(1, room.revision, {type:'claim'});
  assert.throws(() => room.finishClaim(job, undefined));
  assert.equal(room.abandonClaim(job), true);
  assert.equal(room.abandonClaim(job), false);
  assert.deepEqual(room.view(1).game, before);
  assert.equal(room.view(1).scoreboard.rounds, 0);
  const retry = room.act(1, room.revision, {type:'claim'});
  assert.equal(room.finishClaim(job, false), false);
  assert.equal(room.finishClaim(retry, canSweepRemaining(retry)), true);
});
