import assert from 'node:assert/strict';
import test from 'node:test';
import {chipManifest, consentWindow, offeredSeat, followChipHand} from '../chip-play.js';
import {HostSession} from '../session.js';
import {applyAction, createGame, getSpectatorView, getView} from '../table-deal.js';
import {settlements} from '../table-scoring.js';

const owner = 'f220ec2a-36a1-48f9-b934-d0d05d611dbe';
const guest = '5f40869b-33b7-450d-b727-113eeded796e';
const newcomer = 'ca9b49f9-b223-4a93-9c42-5e3be7b3d7f9';
const code = 'TABLE2';
const models = Array(5).fill('heuristic');

function signedRoom() {
  const table = new HostSession('방장', undefined, models, 10, {publicRoom:true});
  assert.equal(table.addGuest('connection','참가자'),null);
  const accounts = new Map([[null,owner],['connection',guest],['next',newcomer]]);
  return {table,accounts};
}

function packet(raw, handId, revision, bots) {
  return {handId, revision, bots, seat:0, game:getView(raw,0), publicGame:getSpectatorView(raw)};
}

function guestSnapshot(table, connection) {
  const {firstSeat,seats} = table.plannedTable();
  const nextDeal = {firstSeat, seats:seats.map(p => ({name:p.name,bot:Boolean(p.bot)}))};
  return {...table.viewFor(connection), chipHost:owner, nextDeal};
}

function finish(raw) {
  const step = action => applyAction(raw,raw.turn,action);
  step({type:'bid',points:14,suit:'H'});
  for (let i=0; i<4; i++) step({type:'pass'});
  step({type:'discard',cards:raw.hands[raw.turn].slice(0,3)});
  step({type:'friend',kind:'none'});
  while (raw.phase==='play') step({type:'play',...getView(raw,raw.turn).choices.plays[0]});
  return settlements(raw.result,raw.bid.suit);
}

test('chip seats bind a verified account, its room, seat, host and table settings', () => {
  const {table,accounts} = signedRoom();
  const plan = table.plannedTable();
  const spec = chipManifest(plan,code,owner,accounts);
  const view = guestSnapshot(table,'connection');
  assert.deepEqual(spec.seats,[owner,guest,null,null,null]);
  assert.deepEqual(spec.names,['방장','참가자','AI 별','AI 구름','AI 바다']);
  assert.equal(offeredSeat(view,spec,code,guest),1);
  assert.equal(offeredSeat(view,spec,'ABC234',guest),-1);
  assert.equal(offeredSeat(view,{...spec,host:guest},code,guest),-1);
  assert.equal(offeredSeat(view,{...spec,firstSeat:(spec.firstSeat+1)%5},code,guest),-1);
  assert.equal(offeredSeat(view,{...spec,names:['다른 사람',...spec.names.slice(1)]},code,guest),-1);
  assert.equal(offeredSeat(view,{...spec,seats:[owner,guest,newcomer,null,null]},code,guest),-1);
  assert.equal(offeredSeat(view,{...spec,models:Array(5).fill('contract_search')},code,guest),-1);
  assert.equal(offeredSeat(view,{...spec,rules:{...spec.rules,minBid:20}},code,guest),-1);
  assert.equal(offeredSeat({...view,game:{phase:'play'}},spec,code,guest),-1);
  assert.throws(() => chipManifest(plan,code,owner,new Map([[null,owner]])));
  assert.throws(() => chipManifest(plan,code,owner,new Map([[null,owner],['connection',owner]])));
  assert.notEqual(chipManifest(plan,code,owner,accounts).handId,spec.handId);
});

test('chip hand consent binds the advertised pace and supports legacy normal-speed rooms', () => {
  const {table,accounts} = signedRoom();
  const plan = table.plannedTable();
  const snapshot = guestSnapshot(table,'connection');
  const legacy = {...snapshot};
  delete legacy.pace;
  const normal = chipManifest({...plan,pace:'normal'},code,owner,accounts);
  assert.equal(Object.hasOwn(normal,'pace'),false);
  assert.equal(offeredSeat(legacy,normal,code,guest),1);
  assert.equal(offeredSeat({...snapshot,pace:'normal'},normal,code,guest),1);
  assert.equal(offeredSeat(legacy,{...normal,pace:'normal'},code,guest),1);
  for (const pace of ['slow','fast']) {
    const spec = chipManifest({...plan,pace},code,owner,accounts);
    const view = {...snapshot,pace};
    assert.equal(spec.pace,pace);
    assert.equal(offeredSeat(view,spec,code,guest),1);
    assert.equal(offeredSeat(view,normal,code,guest),-1);
    assert.equal(offeredSeat(legacy,spec,code,guest),-1);
  }
  for (const pace of [null,'unknown',0]) {
    assert.throws(() => chipManifest({...plan,pace},code,owner,accounts), /속도/);
    assert.equal(offeredSeat({...snapshot,pace},{...normal,pace},code,guest),-1);
  }
});

test('host relays public hands only, settles the dealt-in player once, then seats the reservation', () => {
  const {table,accounts} = signedRoom();
  const spec = chipManifest(table.plannedTable(),code,owner,accounts);
  const raw = createGame({firstSeat:spec.firstSeat,rules:spec.rules});
  const bots = [false,false,true,true,true];
  const first = packet(raw,spec.handId,0,bots);
  assert.equal(first.game.hand.length,10);
  table.startChipHand(first);
  assert.equal(table.addGuest('next','새 참가자','reserve'),null);
  for (const view of [table.hostView(),table.viewFor('connection'),table.viewFor('next')]) {
    assert.equal(view.game.seat,-1);
    assert.deepEqual(view.game.hand,[]);
    assert.deepEqual(view.game.discarded,[]);
    assert.deepEqual(view.game.choices.plays,[]);
    assert.equal(view.game.incomingCards,undefined);
    assert.equal(view.game.hands,undefined);
  }
  assert.equal(table.botTurn,false);
  assert.throws(() => table.act(0,table.revision,{type:'pass'}));
  assert.equal(table.syncChipHand({...first,revision:1,publicGame:first.game}),false);
  assert.equal(table.syncChipHand({...first,handId:crypto.randomUUID(),revision:1}),false);
  table.removeGuest('connection');
  const changes = finish(raw);
  const outcome = packet(raw,spec.handId,1,[false,true,true,true,true]);
  assert.ok(table.syncChipHand(outcome));
  assert.equal(table.syncChipHand(first),false);
  assert.equal(table.syncChipHand(outcome),false);
  const view = table.hostView();
  assert.equal(view.scoreboard.rounds,1);
  const former = view.scoreboard.members.find(m => m.name==='참가자');
  assert.equal(former.rounds,1);
  assert.equal(former.total,changes[1]);
  assert.equal(table.syncChipHand({...outcome,revision:2}),true);
  assert.equal(table.hostView().scoreboard.rounds,1);
  table.startChipHand(outcome); // a replay of the idempotent start response
  assert.equal(table.hostView().scoreboard.rounds,1);
  const booking = guestSnapshot(table,'next');
  assert.equal(booking.seat,-1);
  assert.equal(booking.reservation.seat,1);
  const next = chipManifest(table.plannedTable(),code,owner,accounts);
  assert.deepEqual(next.seats,[owner,newcomer,null,null,null]);
  assert.equal(offeredSeat(booking,next,code,newcomer),1);
  table.startChipHand(packet(createGame(),next.handId,0,bots));
  assert.equal(table.seatFor('next'),1);
  assert.equal(table.viewFor('next').scoreboard.members.find(m => m.name==='새 참가자').rounds,0);
});

test('a repeated or unexpected consent response does not acknowledge another player', async () => {
  const check = consentWindow(['one','two'],crypto.randomUUID());
  assert.equal(check.answer('unknown',true),false);
  assert.equal(check.answer('one',true),true);
  assert.equal(check.answer('one',true),false);
  assert.equal(check.answer('two',false,new Error('이번 판 참가 취소')),true);
  await assert.rejects(check.ready,/참가 취소/);
});

test('spectator polling cannot submit a move and ignores a response after closing', async () => {
  const handId = crypto.randomUUID(), seen = [], calls = [];
  let release, started;
  const reading = new Promise(resolve => {started=resolve;});
  const response = new Promise(resolve => {release=resolve;});
  const initial = {handId,revision:1,seat:-1,game:{phase:'play',turn:0,hand:[]}};
  const follow = followChipHand(async request => {
    calls.push(request);
    started();
    return response;
  },handId,'watch',r=>seen.push(r),assert.fail,initial);
  try {
    follow.start();
    await follow.act({type:'play',card:'SA'});
    await reading;
    follow.close();
    release({...initial,revision:2});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls,[{op:'watch',handId}]);
    assert.deepEqual(seen,[initial]);
  } finally {follow.close();}
});

test('a fast table can read the next AI card before the normal polling interval', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  for (const [pace,ms] of [['normal',450],['fast',293]]) {
    const handId = crypto.randomUUID(), seen = [];
    const initial = {handId,pace,dueAt:Date.now(),revision:1,seat:-1,game:{phase:'play'}};
    const follow = followChipHand(async () => { seen.push(Date.now()); return initial; },
      handId,'watch',() => {},assert.fail,initial);
    try {
      follow.start();
      t.mock.timers.tick(0);
      await Promise.resolve();
      t.mock.timers.tick(ms - 1);
      assert.equal(seen.length,1);
      t.mock.timers.tick(1);
      assert.equal(seen.length,2);
      assert.equal(seen[1] - seen[0],ms);
    } finally { follow.close(); }
  }
});

test('a spectator receives wallet changes between turns without replacing the game frame', {timeout:3000}, async () => {
  const handId = crypto.randomUUID();
  const initial = {handId, revision:5, seat:-1, game:{phase:'play',turn:4}, seatBalances:[40,80,null,null,null]};
  const balances = [40,-12,null,null,null];
  let received;
  const refreshed = new Promise(resolve => { received = resolve; });
  const follow = followChipHand(async () => ({...initial, game:{phase:'result'}, seatBalances:balances}),
    handId,'watch', (data, balancesOnly) => { if (balancesOnly) received(data); },assert.fail,initial);
  try {
    follow.start();
    const data = await refreshed;
    assert.equal(data.game,initial.game);
    assert.deepEqual(data.seatBalances,balances);
    assert.equal(data,follow.current);
  } finally { follow.close(); }
});

test('duplicate and out-of-order wallet replies are ignored and settlement applies the final balances', {timeout:3000}, async () => {
  const handId = crypto.randomUUID(), seen = [];
  const initial = {handId, revision:3, seat:0, game:{phase:'play',turn:0}, seatBalances:[60,20,null,null,null]};
  const balances = [100,0,null,null,null];
  let finishRead, startRead;
  const reading = new Promise(resolve => { startRead = resolve; });
  const actionReplies = [
    {...initial, seatBalances:balances},
    {...initial, seatBalances:[...balances]},
    {...initial, revision:2},
    {...initial, handId:crypto.randomUUID()},
    {...initial, revision:4, game:{phase:'result'}, seatBalances:[108,-8,null,null,null]}
  ];
  const follow = followChipHand(req => {
    if (req.op === 'act') return actionReplies.shift();
    startRead();
    return new Promise(resolve => { finishRead = resolve; });
  },handId,'view',(data, balancesOnly) => seen.push([data.revision,data.seatBalances,Boolean(balancesOnly)]),assert.fail,initial);
  try {
    follow.start();
    await reading;
    await follow.act({type:'pass'});
    finishRead(initial);
    await new Promise(resolve => setImmediate(resolve));
    const remainingReplies = actionReplies.length;
    for (let i = 0; i < remainingReplies; i++) await follow.act({type:'pass'});
    assert.deepEqual(seen,[
      [3,initial.seatBalances,false], [3,balances,true], [4,[108,-8,null,null,null],false]
    ]);
  } finally { follow.close(); }
});

test('ordinary practice deals remain local with a real hand and working turn controls', () => {
  const practice = new HostSession('연습', undefined, models);
  practice.start();
  assert.equal(practice.chipHandId,null);
  assert.equal(practice.hostView().game.hand.length,10);
  practice.act(practice.hostSeat,practice.revision,{type:'bid',points:14,suit:'H'});
  assert.ok(practice.botTurn);
  practice.runBot({type:'pass'});
  assert.equal(practice.hostView().game.bidHistory.length,2);
});
