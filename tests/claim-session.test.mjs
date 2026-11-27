import test from 'node:test';
import assert from 'node:assert/strict';
import {HostSession} from '../session.js';
import {createGame} from '../table-deal.js';
import {analyzeSetting} from '../table-claim.js';
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

test('only a proven declarer can confirm once; the private line becomes public at settlement', () => {
  const room = openAsGuest();
  Object.assign(room.round, {trickNo:9, hands:[['D9','H2'],['SA','HA'],['H3','DJ'],['H4','DK'],['H5','DQ']]});
  const revision = room.revision;
  const job = room.settingCheckPosition();
  assert.ok(job);
  assert.equal(room.view(1).game.choices.canDeclareSetting, false);
  assert.ok(room.view(1).game.choices.plays.length);
  assert.throws(() => room.act(1, revision, {type:'claim',success:true,line:[{card:'SA'},{card:'HA'}]}));
  assert.equal(room.revision, revision);
  assert.equal(room.handoffState(), null);
  const proof = analyzeSetting(job);
  assert.equal(proof.success, true);
  assert.equal(room.finishSettingCheck(structuredClone(job), proof), false);
  assert.equal(room.finishSettingCheck(job, proof), true);
  assert.equal(room.finishSettingCheck(job, proof), false);
  assert.equal(room.settingCheckPosition(), null);
  for (let i = 0; i < 5; i++) {
    const {game} = room.view(i);
    assert.equal(game.choices.canDeclareSetting, i === 1);
    assert.equal(!!game.choices.settingGuaranteed, i === 1);
    assert.equal(game.hands, undefined);
    assert.equal(game.choices.line, undefined);
    assert.equal(game.setting, undefined);
    if (i !== 1) assert.throws(() => room.act(i, revision, {type:'claim'}));
  }
  room.act(1, revision, {type:'claim', success:false, line:[]});
  assert.throws(() => room.act(1, revision, {type:'claim'}));
  for (let i = 0; i < 5; i++) {
    const {game,scoreboard} = room.view(i);
    assert.deepEqual(game.result.setting.line, proof.line);
    assert.equal(game.result.setting.success, true);
    assert.equal(scoreboard.rounds, 1);
    assert.equal(scoreboard.members.reduce((sum, m) => sum + m.total, 0), 0);
    assert.equal(scoreboard.members.find(m => m.seat === 1).total, settlements(room.round.result,'N')[1]);
  }
  room.start();
  assert.equal(room.finishSettingCheck(job, proof), false);
});

test('a losing or interrupted check leaves legal moves, time and score intact; stale results cannot re-enable it', () => {
  const room = openAsGuest();
  Object.assign(room.round, {trickNo:9, hands:[['SA','H2'],['D9','HA'],['H3','DJ'],['H4','DK'],['H5','DQ']]});
  const before = room.view(1);
  const job = room.settingCheckPosition();
  const verdict = analyzeSetting(job);
  assert.equal(verdict.success, false);
  assert.equal(room.finishSettingCheck(job, verdict), false);
  assert.equal(room.settingCheckPosition(), null);
  assert.throws(() => room.act(1, room.revision, {type:'claim',success:true,line:[]}));
  assert.deepEqual(room.view(1).game, before.game);
  assert.equal(room.view(1).turnDeadline, before.turnDeadline);
  assert.equal(room.view(1).scoreboard.rounds, 0);

  const other = openAsGuest();
  const stale = other.settingCheckPosition();
  other.act(1, other.revision, {type:'play', ...other.view(1).game.choices.plays[0]});
  assert.equal(other.finishSettingCheck(stale, {success:true, line:stale.hands[1].map(card=>({card}))}), false);
  assert.equal(other.view(1).game.choices.canDeclareSetting, false);
  assert.equal(other.view(1).scoreboard.rounds, 0);
});
