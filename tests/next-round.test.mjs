import assert from 'node:assert/strict';
import test from 'node:test';
import {createNextRoundTimer} from '../next-round.js';

function fakeClock(t) {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:50000});
  return ms => t.mock.timers.tick(ms);
}

test('a result gets one absolute deadline across repeated renders and starts exactly once', async t => {
  const tick = fakeClock(t), starts = [], states = [];
  const timer = createNextRoundTimer({onStart:key => { starts.push(key); }, onChange:s => states.push(s)});
  timer.sync(null);
  timer.sync('hand-1');
  assert.equal(timer.state.deadline,60000);
  tick(6000);
  timer.sync('hand-1');
  tick(3999);
  assert.deepEqual(starts,[]);
  tick(1);
  assert.deepEqual(starts,['hand-1']);
  await Promise.resolve();
  timer.sync('hand-1');
  tick(30000);
  assert.equal(timer.state,null);
  assert.deepEqual(states.map(s => s?.status),['running','starting',undefined]);
  assert.deepEqual(starts,['hand-1']);
});

test('the host can pause, resume the unused seconds, or start now while paused', async t => {
  const tick = fakeClock(t), starts = [];
  const timer = createNextRoundTimer({onStart:key => { starts.push(key); }});
  timer.sync('hand-1');
  tick(2600);
  timer.pause();
  assert.equal(timer.state.remainingMs,7400);
  assert.equal(timer.state.deadline,null);
  tick(30000);
  timer.sync('hand-1');
  assert.equal(timer.state.status,'paused');
  timer.resume();
  assert.equal(timer.state.deadline,90000);
  tick(7399);
  assert.deepEqual(starts,[]);
  timer.pause();
  assert.equal(timer.state.remainingMs,1);
  assert.equal(await timer.startNow(),true);
  tick(20000);
  assert.deepEqual(starts,['hand-1']);
});

test('a failed automated start stays manual even when the result is synchronized again', async t => {
  const tick = fakeClock(t), errors = [];
  let attempts = 0;
  const timer = createNextRoundTimer({
    onStart:() => { if (++attempts === 1) throw new Error('연결 끊김'); return attempts > 2; },
    onError:error => errors.push(error.message)
  });
  timer.sync('hand-1');
  tick(10000);
  await Promise.resolve();
  assert.equal(timer.state.status,'manual');
  timer.resume();
  timer.sync('hand-1');
  tick(30000);
  assert.equal(attempts,1);
  assert.deepEqual(errors,['연결 끊김']);
  assert.equal(await timer.startNow(),false);
  assert.equal(timer.state.status,'manual');
  assert.equal(await timer.startNow(),true);
  assert.equal(timer.state,null);
});

test('leaving or reaching the series limit cancels the clock and ignores late start completions', async t => {
  const tick = fakeClock(t), starts = [];
  let finish;
  const timer = createNextRoundTimer({onStart:key => {
    starts.push(key);
    return new Promise(resolve => { finish = resolve; });
  }});
  timer.sync('finished');
  timer.sync(null);
  timer.sync('finished');
  tick(30000);
  assert.deepEqual(starts,[]);
  timer.sync('hand-2');
  const pending = timer.startNow();
  assert.equal(await timer.startNow(),false);
  timer.sync(null);
  timer.sync('hand-3');
  const next = timer.state;
  finish(false);
  await pending;
  assert.equal(timer.state,next);
  assert.deepEqual(starts,['hand-2']);
  timer.sync(null);
});
