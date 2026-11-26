import assert from 'node:assert/strict';
import test from 'node:test';
import {callChipService, chipManifest, consentWindow, offeredSeat, followChipHand} from '../chip-play.js';
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

test('room handoff preserves the waiting roster, rule settings, an unrelated seat swap and the admission sequence', () => {
  const table=new HostSession('처음',undefined,models,20,{publicRoom:false,pace:'fast'});
  for (const id of ['successor','other','third']) assert.equal(table.addGuest(id,id),null);
  table.requestSeatSwap('other',3,table.revision);
  const checkpoint=JSON.parse(JSON.stringify(table.handoffState()));
  assert.equal(checkpoint.round,null);
  assert.throws(() => HostSession.takeOver(checkpoint,'unknown'));
  const room=HostSession.takeOver(checkpoint,'successor');
  assert.equal(room.hostSeat,1);
  assert.equal(room.nameFor(null),'successor');
  assert.equal(room.players[0],null);
  assert.equal(room.connections.has('successor'),false);
  assert.equal(room.players[1].memberId,table.players[1].memberId);
  assert.deepEqual(room.viewFor('other').swap,{from:2,to:3});
  room.answerSeatSwap('third',true,room.revision);
  assert.equal(room.seatFor('other'),3);
  assert.equal(room.addGuest('next','새 손님'),null);
  assert.equal(room.seatFor('next'),0);
  assert.equal(new Set(room.players.filter(Boolean).map(p=>p.memberId)).size,4);
  assert.equal(room.hostView().scoreboard.roundLimit,20);
  assert.equal(room.pace,'fast');
  assert.equal(table.hostSeat,0);
  assert.equal(table.players[0].name,'처음');
});

test('mid-hand takeover has no private cards, settles original seats once, and can hand off again after settlement', () => {
  const {table,accounts}=signedRoom();
  table.addGuest('remaining','다른 참가자');
  accounts.set('remaining','ce71018b-3eb5-402c-a3fd-220c214c4122');
  const spec=chipManifest(table.plannedTable(),code,owner,accounts), bots=[false,false,false,true,true];
  const raw=createGame({firstSeat:spec.firstSeat,rules:spec.rules});
  table.startChipHand(packet(raw,spec.handId,0,bots));
  table.addGuest('waiting','대기','reserve');
  assert.equal(table.setGuestDeparture('remaining',spec.handId,true),true);
  const checkpoint=JSON.parse(JSON.stringify(table.handoffState()));
  assert.equal(checkpoint.round.seat,-1);
  assert.deepEqual(checkpoint.round.hand,[]);
  assert.deepEqual(checkpoint.round.discarded,[]);
  for (const key of ['hands','knownKitty','kitty','botMemory','guestDecisions','claim','seats','token','secret']) {
    assert.ok(!Object.hasOwn(checkpoint,key) && !Object.hasOwn(checkpoint.round,key));
  }
  const room=HostSession.takeOver(checkpoint,'connection');
  assert.equal(room.players[0].bot,true);
  assert.equal(room.nameFor(null),'참가자');
  assert.equal(room.players[1].memberId,table.players[1].memberId);
  const changes=finish(raw), result=packet(raw,spec.handId,1,[true,false,false,true,true]);
  assert.equal(room.syncChipHand(result),true);
  assert.equal(room.syncChipHand(result),false);
  const board=room.hostView().scoreboard;
  assert.equal(board.rounds,1);
  for(let i=0;i<5;i++) {
    const id=table.players[i].memberId;
    assert.equal(board.members.find(m=>m.id===id).total,changes[i]);
    assert.equal(board.panelMemberIds[i],id);
  }
  assert.equal(room.seatFor('remaining'),-1);
  assert.equal(room.viewFor('waiting').reservation.seat,0);
  // A reserved spectator can inherit a settled table and take its original reservation.
  const again=HostSession.takeOver(JSON.parse(JSON.stringify(room.handoffState())),'waiting');
  assert.equal(again.hostSeat,-1);
  assert.equal(again.nameFor(null),'대기');
  assert.equal(again.hostView().reservation.seat,0);
  assert.equal(again.syncChipHand({...result,revision:2}),true);
  assert.equal(again.hostView().scoreboard.rounds,1);
  const plan=again.plannedTable();
  assert.equal(plan.seats[0].id,null);
  assert.equal(plan.firstSeat,raw.result.friend ?? raw.result.declarer);
  assert.equal(plan.seats[1].bot,true);
  again.returnToRoom();
  assert.equal(again.hostSeat,0);
  assert.notEqual(again.players[0].memberId,'host');
  assert.equal(again.hostView().scoreboard.members.find(m=>m.id==='host').total,changes[0]);
});

test('promoted guest keeps its scoring identity after yielding to AI and reclaiming a seat as host', () => {
  const {table,accounts}=signedRoom(), spec=chipManifest(table.plannedTable(),code,owner,accounts);
  const raw=createGame({firstSeat:1,rules:spec.rules}), bots=[false,false,true,true,true];
  table.startChipHand(packet(raw,spec.handId,0,bots));
  const id=table.players[1].memberId;
  const room=HostSession.takeOver(table.handoffState(),'connection');
  room.leaveHostSeat();
  room.setReservation(null,true);
  finish(raw);
  room.syncChipHand(packet(raw,spec.handId,1,[true,true,true,true,true]));
  assert.equal(room.plannedTable().firstSeat,room.hostView().reservation.seat);
  room.returnToRoom();
  assert.equal(room.players[room.hostSeat].memberId,id);
  assert.equal(room.hostView().scoreboard.members.filter(m=>m.id===id).length,1);
  const practice=new HostSession('연습');
  practice.start();
  assert.equal(practice.handoffState(),null);
});

function finish(raw) {
  const step = action => applyAction(raw,raw.turn,action);
  step({type:'bid',points:14,suit:'H'});
  for (let i=0; i<4; i++) step({type:'pass'});
  step({type:'discard',cards:raw.hands[raw.turn].slice(0,3)});
  step({type:'friend',kind:'none'});
  while (raw.phase==='play') step({type:'play',...getView(raw,raw.turn).choices.plays[0]});
  return settlements(raw.result,raw.bid.suit);
}

test('handoff recovers an already committed deal under its original roster including a newly seated reservation', () => {
  const {table}=signedRoom();
  const first=crypto.randomUUID(), firstRaw=createGame(), bots=[false,false,true,true,true];
  table.startChipHand(packet(firstRaw,first,0,bots));
  table.addGuest('waiting','예약 참가자','reserve');
  finish(firstRaw);
  table.syncChipHand(packet(firstRaw,first,1,bots));
  const before=table.handoffState(), reservation=table.viewFor('waiting').reservation.seat;
  const next=crypto.randomUUID(), raw=createGame({firstSeat:table.plannedTable().firstSeat});
  const nextBots=Array.from({length:5},(_,i)=>![0,1,reservation].includes(i));
  const committed=packet(raw,next,0,nextBots);
  table.startChipHand(committed);
  const expected=table.players.map(p=>p.memberId);
  const room=HostSession.takeOver(before,'waiting',committed);
  assert.equal(room.hostSeat,reservation);
  assert.equal(room.players[reservation].name,'예약 참가자');
  assert.equal(room.nameFor(null),'예약 참가자');
  assert.equal(room.players[0].bot,true);
  assert.deepEqual(room.handoffState().roundMembers,expected);
  assert.deepEqual(room.handoffState().round.hand,[]);
  finish(raw);
  const result=packet(raw,next,1,nextBots.map((bot,i)=>bot || i===0));
  room.syncChipHand(result);
  assert.equal(room.syncChipHand(result),false);
  assert.equal(room.hostView().scoreboard.rounds,2);
  assert.deepEqual(room.hostView().scoreboard.panelMemberIds,expected);
});

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

test('a reserved exit keeps the dealt seat through settlement and opens it for the next reservation', () => {
  const {table,accounts} = signedRoom();
  const spec = chipManifest(table.plannedTable(),code,owner,accounts);
  const raw = createGame();
  const bots = [false,false,true,true,true];
  table.startChipHand(packet(raw,spec.handId,0,bots));
  table.addGuest('next','새 참가자','reserve');
  assert.equal(table.setGuestDeparture('next',spec.handId,true),false);
  assert.equal(table.setGuestDeparture('connection',crypto.randomUUID(),true),false);
  assert.ok(table.setGuestDeparture('connection',spec.handId,true));
  assert.ok(table.setGuestDeparture('connection',spec.handId,true));
  assert.equal(table.seatFor('connection'),1);
  assert.equal(table.players[1].bot,false);
  assert.equal(table.viewFor('next').reservation.seat,null);

  const changes = finish(raw);
  const result = packet(raw,spec.handId,1,bots);
  table.syncChipHand(result);
  table.syncChipHand({...result,revision:2});
  assert.equal(table.seatFor('connection'),-1);
  const row = table.hostView().scoreboard.members.find(m => m.name === '참가자');
  assert.deepEqual([row.rounds,row.lastSeat,row.lastDelta,row.total],[1,1,changes[1],changes[1]]);
  assert.equal(table.hostView().players[1].name,'참가자');
  assert.equal(table.viewFor('next').reservation.seat,1);
  table.removeGuest('connection');
  const next = chipManifest(table.plannedTable(),code,owner,accounts);
  assert.deepEqual(next.seats,[owner,newcomer,null,null,null]);
});

test('cancelling a reserved exit retains the seat and a previous hand cannot reserve the next exit', () => {
  const table = new HostSession('방장',undefined,models);
  table.addGuest('connection','방원');
  const bots = [false,false,true,true,true], handId = crypto.randomUUID(), raw = createGame();
  table.startChipHand(packet(raw,handId,0,bots));
  assert.ok(table.setGuestDeparture('connection',handId,true));
  assert.ok(table.setGuestDeparture('connection',handId,false));
  finish(raw);
  table.syncChipHand(packet(raw,handId,1,bots));
  assert.equal(table.seatFor('connection'),1);
  assert.equal(table.plannedTable().seats[1].id,'connection');
  assert.equal(table.setGuestDeparture('connection',handId,false),false);
  const second = crypto.randomUUID();
  const secondRaw = createGame();
  table.startChipHand(packet(secondRaw,second,0,bots));
  assert.equal(table.setGuestDeparture('connection',handId,true),false);
  finish(secondRaw);
  table.syncChipHand(packet(secondRaw,second,1,bots));
  assert.ok(table.setGuestDeparture('connection',second,true));
  assert.equal(table.seatFor('connection'),-1);
  table.removeGuest('connection');
  assert.equal(table.players[1].bot,true);
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
    assert.equal(await follow.act({type:'play',card:'SA'}),false);
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

test('a human turn uses the server clock and wakes on its deadline, even at slow pace', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  const handId = crypto.randomUUID(), calls = [];
  const initial = {handId,revision:1,seat:-1,pace:'slow',game:{phase:'bid',turn:0},
    serverNow:501000,turnDeadline:501200,dueAt:501200};
  const reader = followChipHand(async () => {
    calls.push(Date.now());
    return calls.length === 1 ? initial : {...initial, revision:2, turnDeadline:null, dueAt:null, game:{phase:'result'}};
  },handId,'watch',() => {},assert.fail,initial);
  try {
    reader.start();
    assert.equal(reader.localTurnDeadline,1200);
    t.mock.timers.tick(0);
    await Promise.resolve();
    t.mock.timers.tick(249);
    assert.deepEqual(calls,[1000]);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.deepEqual(calls,[1000,1250]);
    assert.equal(reader.localTurnDeadline,null);
  } finally { reader.close(); }
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

test('a revision hint received during a read bypasses the human turn polling delay once', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  const handId = crypto.randomUUID();
  const initial = {handId,seat:-1,revision:1,dueAt:200000,game:{phase:'play'}};
  let calls = 0, finishRead;
  const reader = followChipHand(() => {
    calls++;
    return calls === 1 ? new Promise(resolve => { finishRead = resolve; }) : {...initial, revision:2};
  }, handId, 'watch', () => {}, assert.fail, initial);
  try {
    reader.start();
    t.mock.timers.tick(0);
    reader.wake(2);
    reader.wake(2);
    finishRead(initial);
    await Promise.resolve();
    t.mock.timers.tick(0);
    assert.equal(calls,2);
    await Promise.resolve();
    reader.wake(2);
    t.mock.timers.tick(3199);
    assert.equal(calls,2, 'already delivered revisions should leave the ordinary polling schedule intact');
    t.mock.timers.tick(1);
    assert.equal(calls,3);
  } finally { reader.close(); }
});

test('a host pace edit and a card submitted together use successive revisions', async () => {
  const handId = crypto.randomUUID(), calls = [], events = [];
  const first = {handId,revision:4,pace:'normal',seat:0,game:{phase:'play',turn:0},publicGame:{seat:-1}};
  const paced = {...first, revision:5, pace:'fast'};
  const played = {...paced, revision:6, game:{phase:'play',turn:1}};
  let finishPace;
  const reader = followChipHand(async req => {
    calls.push(req);
    if (req.op === 'pace') return new Promise(resolve => { finishPace = resolve; });
    assert.equal(req.op,'act');
    return played;
  },handId,'view',(data, wallets, paceOnly) => events.push([data.revision,paceOnly]),assert.fail,first);
  try {
    reader.start();
    const changing = reader.changePace('fast');
    const moving = reader.act({type:'pass'});
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls,[{op:'pace',pace:'fast',handId}]);
    finishPace(paced);
    await Promise.all([changing,moving]);
    assert.deepEqual(calls[1],{op:'act',handId,revision:5,action:{type:'pass'}});
    assert.deepEqual(events,[[4,false],[5,true],[6,false]]);
  } finally { reader.close(); }
});

test('a player move retries the host pace revision without repeating a played card', async () => {
  const handId = crypto.randomUUID(), actionRevisions = [];
  const initial = {handId,revision:1,pace:'normal',seat:2,game:{phase:'play',turn:2,hand:['H8']}};
  const paceReply = {...initial,revision:2,pace:'fast'};
  const actionReply = {...paceReply,revision:3,game:{phase:'play',turn:3,hand:[]}};
  const reader = followChipHand(async req => {
    assert.equal(req.op, 'act');
    actionRevisions.push(req.revision);
    return actionRevisions.length === 1 ? paceReply : actionReply;
  },handId,'view',() => {},assert.fail,initial);
  try {
    reader.start();
    await assert.rejects(reader.changePace('slow'), /방장/);
    assert.equal(await reader.act({type:'play',card:'H8'}),true);
    assert.deepEqual(actionRevisions,[1,2]);
    assert.equal(reader.current,actionReply);
  } finally { reader.close(); }
});

test('a card play needs a newer private hand from the same deal and seat to confirm it', async () => {
  const handId = crypto.randomUUID(), seat = 2;
  const first = {handId,seat,revision:5,game:{phase:'play',turn:seat,hand:['H8','SA'],dealNo:1,trickNo:4}};
  const played = {...first,revision:6,game:{...first.game,turn:3,hand:['SA']}};
  const setting = {...played,game:{...played.game,phase:'result',result:{setting:{}},hand:[]}};
  for (const [reply, expected] of [
    [first,false], [{...played,game:first.game},false], [{...played,revision:4},false],
    [{...played,seat:-1},false], [{...played,handId:crypto.randomUUID()},false],
    [{...played,game:{...played.game,dealNo:2}},false], [setting,false],
    [{...setting,game:{...setting.game,lastTrick:{number:4,finalPlay:{seat,card:'H8'}}}},true],
    [played,true]
  ]) {
    const reader = followChipHand(async () => reply,handId,'view',() => {},assert.fail,first);
    try {
      reader.start();
      assert.equal(await reader.act({type:'play',card:'H8'}),expected);
    } finally { reader.close(); }
  }
});

test('a lost play reply is verified with one private read and no second submission', async () => {
  const handId = crypto.randomUUID();
  const first = {handId,seat:2,revision:1,game:{phase:'play',turn:2,hand:['H8'],dealNo:1,trickNo:5}};
  const played = {...first,revision:2,game:{...first.game,turn:3,hand:[]}};
  const failed = new TypeError('연결이 끊겼습니다.');
  for (const [error, view, confirms, ops] of [
    [failed,played,true,['act','view']],
    [Object.assign(new Error('서버 응답 실패'),{status:503}),played,true,['act','view']],
    [failed,first,false,['act','view']],
    [failed,new Error('조회 실패'),false,['act','view']],
    [Object.assign(new Error('카드를 낼 수 없습니다.'),{status:400}),played,false,['act']]
  ]) {
    const calls = [];
    const reader = followChipHand(async req => {
      calls.push(req.op);
      if (req.op === 'act') throw error;
      if (view instanceof Error) throw view;
      return view;
    },handId,'view',() => {},assert.fail,first);
    try {
      reader.start();
      const receipt = reader.act({type:'play',card:'H8'});
      if (confirms) assert.equal(await receipt,true);
      else await assert.rejects(receipt,view instanceof Error ? view : error);
      assert.deepEqual(calls,ops);
    } finally { reader.close(); }
  }
});

test('a card selected during a pace edit cannot be submitted in another trick', async () => {
  const handId = crypto.randomUUID();
  const first = {handId,seat:0,revision:4,pace:'normal',publicGame:{},game:{phase:'play',turn:0,hand:['H8','SA'],trickNo:1}};
  const next = {...first,revision:10,pace:'fast',game:{...first.game,trickNo:2,hand:['H8']}};
  const calls = [];
  const reader = followChipHand(async req => { calls.push(req.op); return next; },handId,'view',() => {},assert.fail,first);
  try {
    reader.start();
    const update = reader.changePace('fast');
    const receipt = reader.act({type:'play',card:'H8'});
    await update;
    assert.equal(await receipt,false);
    assert.deepEqual(calls,['pace']);
  } finally { reader.close(); }
});

test('a queued bid cannot pass for the player again after the server played the original turn', async () => {
  const handId = crypto.randomUUID();
  const initial = {handId,seat:0,revision:1,pace:'normal',publicGame:{},game:{phase:'bid',turn:0,bidHistory:[]}};
  const next = {...initial,revision:6,pace:'fast',game:{...initial.game,
    bidHistory:[{seat:0,points:14,suit:'H'},{seat:1,points:15,suit:'S'}]}};
  const calls = [];
  const reader = followChipHand(async req => { calls.push(req.op); return next; },handId,'view',() => {},assert.fail,initial);
  try {
    reader.start();
    const update = reader.changePace('fast');
    const pending = reader.act({type:'pass'});
    await Promise.all([update,pending]);
    assert.deepEqual(calls,['pace']);
  } finally { reader.close(); }
});

test('a truncated successful play response triggers a private read', async t => {
  const handId = crypto.randomUUID(), ops = [];
  const first = {handId,seat:1,revision:4,game:{phase:'play',turn:1,hand:['H8'],dealNo:1}};
  const played = {...first,revision:5,game:{...first.game,turn:2,hand:[]}};
  const client = {url:'https://example.invalid',publishableKey:'test',accessToken:async () => 'session'};
  t.mock.method(globalThis,'fetch',async (_url, options) => {
    const {op} = JSON.parse(options.body);
    assert.equal(options.headers.Authorization,'Bearer session');
    ops.push(op);
    return op === 'act' ? new Response('{"game":') : Response.json(played);
  });
  const reader = followChipHand(req => callChipService(client,req),handId,'view',() => {},assert.fail,first);
  try {
    reader.start();
    assert.equal(await reader.act({type:'play',card:'H8'}),true);
    assert.deepEqual(ops,['act','view']);
  } finally { reader.close(); }
});

test('an overlapping private poll can confirm the play even if the recovery read fails', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const handId = crypto.randomUUID(), ops = [];
  const first = {handId,seat:1,revision:4,game:{phase:'play',turn:1,hand:['H8'],dealNo:1}};
  const played = {...first,revision:5,game:{...first.game,turn:2,hand:[]}};
  let releasePoll, startRecovery, rejectRecovery;
  const recoveryStarted = new Promise(resolve => { startRecovery = resolve; });
  const reader = followChipHand(async req => {
    ops.push(req.op);
    if (ops.length === 1) return new Promise(resolve => { releasePoll = resolve; });
    if (req.op === 'act') throw new TypeError('연결이 끊겼습니다.');
    startRecovery();
    return new Promise((_, reject) => { rejectRecovery = reject; });
  },handId,'view',() => {},assert.fail,first);
  try {
    reader.start();
    t.mock.timers.tick(0);
    const receipt = reader.act({type:'play',card:'H8'});
    await recoveryStarted;
    releasePoll(played);
    rejectRecovery(new Error('조회 실패'));
    assert.equal(await receipt,true);
    assert.deepEqual(ops,['view','act','view']);
  } finally { reader.close(); }
});
