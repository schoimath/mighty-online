import test from 'node:test';
import assert from 'node:assert/strict';
import {HostSession} from '../session.js';
import {rngFor} from '../lab/game.js';
import {recurrentModels} from '../lab/artifacts/recurrent-aux/selected.js';
import {createRecurrentPolicy, replayRecurrentMemory} from '../lab/recurrent.js';
import {botObservation} from '../engine.js';
import {playLiveEpisode} from '../lab/live-game.js';
import {ruleAction} from '../lab/rules-agents.js';
import {decideTableTurn} from '../lab/table-agents.js';

test('four identical models keep separate private memories through worker retries and a rematch', () => {
  const room = new HostSession('방장', undefined, Array(5).fill('recurrent_balanced'));
  const reference = Array.from({length:5}, () => createRecurrentPolicy(recurrentModels.balanced, 'balanced'));
  room.start();
  room.act(0, room.revision, {type:'bid', suit:'N', points:20});
  const seen = new Set();
  let job = 0;
  while (room.round.phase !== 'result') {
    const seat = room.round.turn;
    if (seat === 0) {
      const v = room.view(0).game;
      const action = v.phase === 'discard' ? {type:'discard', cards:v.hand.slice(0,3)}
        : v.phase === 'friend' ? {type:'friend', kind:'none'} : {type:'play', ...v.choices.plays[0]};
      room.act(seat, room.revision, action);
      continue;
    }
    const request = room.botRequest(++job);
    assert.deepEqual(request.memory, reference[seat].getMemory());
    const reply = decideTableTurn(request);
    assert.deepEqual(reply.action, reference[seat](request.view, rngFor(job)));
    assert.deepEqual(reply.memory, reference[seat].getMemory());
    assert.deepEqual(room.botRequest(job), request);
    assert.ok(!JSON.stringify(room.view(0)).includes('"memory"'));
    if (job % 2) room.runBot(undefined, job);
    else room.runBot(reply.action, job, reply.memory);
    seen.add(seat);
  }
  assert.equal(seen.size, 4);
  room.start();
  room.act(0, room.revision, {type:'pass'});
  assert.equal(room.botRequest(0).memory, null);
});

test('a five-pass redeal clears every seat memory including the last passer', () => {
  const room = new HostSession('방장', undefined, Array(5).fill('recurrent_win'));
  room.start();
  room.act(0, room.revision, {type:'pass'});
  for (let i=1;i<5;i++) {
    const request = room.botRequest(i);
    const {memory} = decideTableTurn(request);
    assert.equal(request.memory,null);
    room.runBot({type:'pass'}, i, memory);
  }
  assert.equal(room.round.dealNo,2);
  for (let i=1;i<5;i++) {
    assert.equal(room.botRequest(i).memory,null);
    room.runBot({type:'pass'});
  }
});

test('a substitute reconstructs its own past decisions including the human’s revised contract', () => {
  const room = new HostSession('방장', undefined, Array(5).fill('recurrent_score'));
  room.addGuest('guest', '손님');
  room.start();
  const history = [];
  function guest(action) {
    history.push({observation:botObservation(room.round, 1), action});
    room.act(1, room.revision, action);
  }
  room.act(0,room.revision,{type:'pass'});
  guest({type:'bid', suit:'H', points:14});
  for (let i=2;i<5;i++) room.runBot({type:'pass'});
  guest({type:'discard', cards:room.view(1).game.hand.slice(0,3), contract:{suit:'D', points:16}});
  room.removeGuest('guest');
  const request = room.botRequest(28);
  assert.deepEqual(request.memory, replayRecurrentMemory(recurrentModels.score, 'score', history));
  assert.ok(Array.isArray(request.memory));
  assert.equal(request.view.phase,'friend');
});

test('recurrent seats finish randomized games at every room rule setting', () => {
  let decisions = 0;
  for (let seed = 0; seed < 128; seed++) {
    const goal = ['win','score','balanced'][seed % 3], seat = seed % 5;
    const rules = {minBid:13 + (seed % 8), allowFirstFriend:Boolean(seed & 8),
      allowFirstJokerCall:Boolean(seed & 16), allowLastJoker:Boolean(seed & 32)};
    const policies = Array.from({length:5}, (_, s) => s === seat ? createRecurrentPolicy(recurrentModels[goal],goal)
      : (view, rng) => ruleAction('random',view,rng));
    const game = playLiveEpisode({seed:8100000 + seed, firstSeat:(seed + 1) % 5, policies, rules});
    decisions += game.actions;
    assert.equal(game.outcomes.reduce((sum, p) => sum + p.settlement, 0),0);
    assert.ok(game.attackPoints >= 0 && game.attackPoints <= 20);
  }
  assert.ok(decisions >= 50 * 128);
});
