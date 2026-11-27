import assert from 'node:assert/strict';
import test from 'node:test';
import {followChipHand} from '../chip-play.js';

const visiblePublic = {publicTable:() => true, isVisible:() => true};

test('a solo presence renewal preserves an in-progress selection until the game actually changes', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  const handId = crypto.randomUUID();
  const original = {handId,revision:1,seat:0,bots:[false,true,true,true,true],turnDeadline:191000,
    seatTimeBanks:[180000,null,null,null,null],game:{phase:'discard',turn:0,hand:['S5','H8','D6']}};
  const renewed = {...original,revision:2,seatTimeBanks:[100000,null,null,null,null]};
  const moved = {...renewed,revision:3,game:{...original.game,phase:'play'}};
  const responses = [renewed,moved], changes = [];
  const reader = followChipHand(async () => responses.shift(),handId,'view',
    (_,balancesOnly,sameDecision) => changes.push(sameDecision),assert.fail,original);
  try {
    reader.start();
    await reader.refresh();
    await reader.refresh();
    assert.deepEqual(changes,[false,true,false]);
  } finally { reader.close(); }
});

test('a visible public reader follows another human closely, then backs off on the same turn', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0});
  const handId = crypto.randomUUID(), times = [];
  const state = {handId,revision:1,seat:3,bots:[false,true,false,false,true],dueAt:180000,
    game:{phase:'play',turn:2,trickNo:1}};
  const reader = followChipHand(async () => { times.push(Date.now()); return state; },
    handId,'view',() => {},assert.fail,state,visiblePublic);
  try {
    reader.start();
    for (const delay of [0,800,800,800,800,800,1600,1600,1600,1600,3200]) {
      t.mock.timers.tick(delay);
      await Promise.resolve();
    }
    assert.deepEqual(times,[0,800,1600,2400,3200,4000,5600,7200,8800,10400,13600]);
  } finally { reader.close(); }
});

test('own turns and background tables keep their ordinary interval; short bot delays honor the due time', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0});
  for (const [seat, bot, visible, dueIn, expected] of [
    [2,false,true,180000,3200], [-1,false,false,180000,3200], [-1,true,true,150,200],
    [0,true,true,-50,120], [0,false,true,100,150]
  ]) {
    const handId = crypto.randomUUID(), times = [], dueAt = Date.now() + dueIn;
    const state = {handId,revision:1,seat,bots:[false,false,bot,true,true],dueAt,turnDeadline:bot ? null : dueAt,
      game:{phase:'play',turn:2,trickNo:2}};
    const reader = followChipHand(async () => { times.push(Date.now()); return state; },
      handId,seat < 0 ? 'watch' : 'view',() => {},assert.fail,state,{...visiblePublic,isVisible:() => visible});
    try {
      reader.start();
      t.mock.timers.tick(0);
      await Promise.resolve();
      t.mock.timers.tick(expected - 1);
      assert.equal(times.length,1);
      t.mock.timers.tick(1);
      assert.equal(times.length,2);
    } finally { reader.close(); }
  }
});

test('all reads and writes use the last accepted play cursor, including same-revision renewals and overlapping requests', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  const handId = crypto.randomUUID(), calls = [], painted = [];
  const initial = {handId,revision:1,seat:0,game:{phase:'play',turn:0,trickNo:1,hand:['D3']},playCursor:'original'};
  const pending = Promise.withResolvers();
  const replies = [pending.promise,{...initial,playCursor:'renewed'},
    {...initial,revision:2,game:{...initial.game,turn:1,hand:[]},playCursor:'after-play',recentTricks:[]},
    {...initial,revision:3,game:{...initial.game,turn:2,hand:[]},recentTricks:[{number:1}]}
  ];
  const reader = followChipHand(async req => { calls.push(req); return replies.shift(); },
    handId,'view',data => painted.push(data),assert.fail,initial);
  try {
    reader.start();
    t.mock.timers.tick(0);
    await reader.refresh();
    assert.equal(painted.length,1);
    pending.resolve({...initial,playCursor:'older-response'});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await reader.act({type:'play',card:'D3'}),true);
    await reader.refresh();
    assert.deepEqual(calls.map(req => [req.op,req.playCursor]),[
      ['view','original'],['view','original'],['act','renewed'],['view','after-play']
    ]);
    assert.deepEqual(reader.current.recentTricks,[{number:1}]);
    assert.deepEqual(painted.map(state=>state.revision),[1,2,3]);
  } finally { reader.close(); }
});
