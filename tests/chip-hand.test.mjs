import test from 'node:test';
import assert from 'node:assert/strict';
import {operateHand} from '../supabase/functions/chip-hand/hand.js';
import {chipHandler} from '../supabase/functions/chip-hand/handler.js';
import {settlements} from '../table-scoring.js';
import {validateRules} from '../engine.js';
import {botTurnDelay, tableDelay} from '../table-timing.js';

const host = 'b11255ac-bd23-4fd4-af36-aaaaaaaaaaaa';
const guest = 'b11255ac-bd23-4fd4-af36-bbbbbbbbbbbb';
const other = 'b11255ac-bd23-4fd4-af36-dddddddddddd';
const handId = '835d7a38-0db9-4a32-b721-6232d8ca3844';
const game = {handId, host, room:'TABLE2', seats:[host,guest,null,null,null],
  names:['방장','친구','AI 별','AI 구름','AI 바다'], models:Array(5).fill('heuristic'), firstSeat:0};
const at = 1_800_000_000_000;

function table() {
  let row = null, charges = 0;
  let operator = {id:host, term:1, credential:'a'.repeat(64), departedSeats:[]};
  let beforeNextSave = null;
  const clone = value => structuredClone(value);
  const grants = new Map();
  async function call(id, op, fields = {}, now = at) {
    const db = {
      ready(hand, room, seat, hash) { grants.set(id,{hand,room,seat,hash}); },
      start(hand, spec, state) {
        if (!row) {
          for (const player of new Set([spec.host,...spec.seats.filter(Boolean)])) {
            assert.deepEqual(grants.get(player),{hand,room:spec.room,seat:spec.seats.indexOf(player),hash:state.manifest});
          }
          row = {hand, room:spec.room, host:spec.host, seats:spec.seats, revision:0, state:clone(state), settled:false,
            seatBalances:spec.seats.map(id => id === host ? 120 : id === guest ? 300 : null)};
        }
        return clone(row);
      },
      read:() => clone(row),
      async control(hand, proof, update) {
        assert.equal(hand,handId);
        const authorized = proof.legacy ? proof.id === host && operator.id === host :
          proof.id === operator.id && proof.credential === operator.credential && proof.term === operator.term;
        if (!authorized) throw Object.assign(new Error('방장 권한을 확인해 주세요.'), {status:403});
        return {hand:update ? await db.save(update) : clone(row), departedSeats:[...operator.departedSeats]};
      },
      async save(update) {
        if (beforeNextSave) {
          const pending = beforeNextSave;
          beforeNextSave = null;
          await pending();
        }
        if (row.revision === update.revision && !row.settled) {
          row = {...clone(update), revision:row.revision+1, settled:Boolean(update.state.round.result)};
          if (row.settled) {
            const deltas = settlements(row.state.round.result, row.state.round.bid.suit);
            row.seatBalances = row.seatBalances.map((balance,i) => balance === null ? null : balance + deltas[i]);
            charges++;
          }
        }
        return clone(row);
      }
    };
    return operateHand({handId, op, ...fields}, id, db, now);
  }
  return {call, row:() => clone(row), charges:() => charges,
    controller(next) { operator = next; },
    beforeNextSave(callback) { beforeNextSave = callback; }};
}

test('verified seats consent to one match specification and receive separate projections', async () => {
  const t = table();
  await t.call(host,'ready',game);
  await assert.rejects(t.call(guest,'start',game),{status:403});
  await assert.rejects(t.call(null,'ready',game),{status:401});
  await assert.rejects(t.call(other,'ready',game),{status:403});
  await t.call(guest,'ready',game);
  await assert.rejects(t.call(host,'start',{...game, firstSeat:1}));
  const first = await t.call(host,'start',game);
  assert.equal(first.seat,0);
  assert.equal(first.game.hand.length,10);
  assert.equal(first.publicGame.seat,-1);
  assert.deepEqual(first.publicGame.hand,[]);
  assert.deepEqual(first.seatBalances,[120,300,null,null,null]);
  assert.deepEqual((await t.call(host,'start',game)).game.hand,first.game.hand);
  const second = await t.call(guest,'view');
  assert.ok(second.game.hand.every(c => !first.game.hand.includes(c)));
  assert.equal(second.publicGame,undefined);
  const watcher = await t.call(host,'watch');
  assert.deepEqual(watcher.game.hand,[]);
  assert.equal(watcher.game.selfRole,'spectator');
  assert.deepEqual(watcher.seatBalances,first.seatBalances);
  assert.ok(!JSON.stringify(watcher).includes(host));
  assert.ok(!('state' in watcher) && !('round' in watcher));
  await assert.rejects(t.call(other,'view'),{status:403});
  await assert.rejects(t.call(guest,'act',{revision:0,action:{type:'pass'},seat:0}));
  const played = await t.call(host,'act',{revision:0,action:{type:'bid',points:14,suit:'H'}});
  const retry = await t.call(host,'act',{revision:0,action:{type:'pass'}});
  assert.deepEqual(retry.game.bidHistory,played.game.bidHistory);
  assert.equal(retry.revision,1);
});

test('successive room hosts keep public projections, immutable wallets and only retire former host seats', async () => {
  const t = table(), spec = {...game,seats:[host,guest,other,null,null]};
  for (const player of spec.seats.filter(Boolean)) await t.call(player,'ready',spec);
  await t.call(host,'start',spec);
  const successor = {term:2,credential:'b'.repeat(64)};
  t.controller({...successor,id:guest,departedSeats:[0]});
  for (const [actor,proof] of [[null,successor],[host,successor],[guest,{...successor,term:1}],[guest,{term:2}],[guest,{...successor,credential:'a'.repeat(64)}]]) {
    await assert.rejects(t.call(actor,'room-takeover',proof), {status:403});
  }
  await assert.rejects(t.call(host,'pace',{pace:'fast'}),{status:403});
  const result = await t.call(guest,'room-takeover',{...successor,seat:2,departedSeats:[2]});
  assert.deepEqual(result.bots,[true,false,false,true,true]);
  assert.deepEqual(result.game,result.publicGame);
  assert.deepEqual(result.game.hand,[]);
  assert.equal(result.seat,-1);
  assert.equal((await t.call(guest,'view')).game.hand.length,10);
  assert.equal((await t.call(guest,'room-takeover',successor)).revision,result.revision);
  const observer = {term:3,credential:'c'.repeat(64)};
  t.controller({...observer,id:null,departedSeats:[0,1]});
  await assert.rejects(t.call(guest,'room-pace',{...successor,pace:'fast'}), {status:403});
  assert.deepEqual((await t.call(null,'room-takeover',observer)).bots,[true,true,false,true,true]);
  const fast = await t.call(null,'room-pace',{...observer,pace:'fast'});
  assert.equal(fast.pace,'fast');
  assert.deepEqual(fast.publicGame.hand,[]);
  assert.deepEqual(t.row().seats,spec.seats);
  assert.equal((await t.call(other,'view')).game.hand.length,10);
  assert.equal(t.charges(),0);
});

test('a chip hand commits burial and friend once and only publishes the finished call', async () => {
  const t = table(), seats = [host,guest,other,crypto.randomUUID(),crypto.randomUUID()];
  const spec = {...game, seats, models:seats.map(() => 'recurrent_balanced'), rules:{allowFirstFriend:false}};
  for (const id of seats) await t.call(id,'ready',spec);
  await t.call(host,'start',spec);
  await t.call(host,'act',{revision:0, action:{type:'bid',suit:'H',points:14}});
  for (const id of seats.slice(1)) await t.call(id,'act',{revision:t.row().revision, action:{type:'pass'}});
  const declarer = await t.call(host,'view'), revision = declarer.revision;
  assert.ok(declarer.game.choices.discardFriends.some(f => f.kind === 'none'));
  assert.equal(declarer.publicGame.choices.discardFriends,undefined);
  const cards = declarer.game.hand.slice(0,3), contract = {suit:'D',points:16};
  const before = t.row(), action = {type:'prepare', cards, contract, friend:{kind:'first'}};
  await assert.rejects(t.call(host,'act',{revision,action}),/프렌드/);
  assert.deepEqual(t.row(),before);
  action.friend = {kind:'card',card:before.state.round.hands[1][0]};
  const result = await t.call(host,'act',{revision,action});
  assert.equal(result.revision, revision+1);
  assert.equal(result.game.phase,'play');
  assert.deepEqual(result.publicGame.call,action.friend);
  assert.deepEqual(result.publicGame.discarded,[]);
  assert.equal(result.publicGame.friend,null);
  assert.deepEqual(result.game.discarded,cards);
  assert.deepEqual(result.game.bid,{seat:0,...contract});
  assert.deepEqual(result.seatBalances,declarer.seatBalances);
  const history = t.row().state.history[0];
  assert.deepEqual(history.map(entry => entry.observation.phase),['bid','discard','friend']);
  assert.deepEqual(history.at(-1).observation.hand,result.game.hand);
  assert.equal((await t.call(host,'act',{revision,action})).revision,result.revision);
  assert.deepEqual(t.row().state.history[0],history);
  assert.equal(t.charges(),0);
});

test('server plays abandoned hands to completion and only its terminal deltas are settled', async () => {
  const t = table();
  for (const id of [host,guest]) await t.call(id,'ready',game);
  await t.call(host,'start',game);
  // A returning player may still control their seat after a timed-out action.
  const resumed = await t.call(host,'view',{},at+90_000);
  assert.equal(resumed.game.bidHistory.length,1);
  assert.equal(resumed.seat,0);
  const left = await t.call(host,'leave',{seat:1},at+90_001);
  assert.deepEqual(left.bots,[true,false,true,true,true]);
  assert.deepEqual(left.seatBalances,[null,300,null,null,null]);
  assert.equal(left.seat,-1);
  assert.equal(left.turnDeadline,null);
  assert.equal(left.myDelta,undefined);
  assert.equal(left.mySettlementSeat,undefined);
  assert.deepEqual(left.game.hand,[]);
  await assert.rejects(t.call(host,'act',{revision:left.revision,action:{type:'pass'}}),{status:403});
  for (let i=0; i<100 && !t.row().settled; i++) {
    await t.call(null,'tick',{p_deltas:[500,0,0,0,0]},at+(i+1)*180_000);
  }
  const actual=t.row();
  assert.equal(actual.settled,true);
  const result=await t.call(null,'watch');
  assert.deepEqual(result.deltas,settlements(actual.state.round.result,actual.state.round.bid.suit));
  assert.deepEqual(result.seatBalances,[120+result.deltas[0],300+result.deltas[1],null,null,null]);
  assert.equal(result.myDelta,undefined);
  assert.equal(result.mySettlementSeat,undefined);
  const departed = await t.call(host,'view'), timedOut = await t.call(guest,'view');
  assert.equal(departed.seat,-1);
  assert.equal(departed.myDelta,result.deltas[0]);
  assert.equal(departed.mySettlementSeat,0);
  assert.equal(timedOut.myDelta,result.deltas[1]);
  assert.equal(timedOut.mySettlementSeat,1);
  const watching = await t.call(host,'watch');
  assert.equal(watching.myDelta,undefined);
  assert.equal(watching.mySettlementSeat,undefined);
  assert.deepEqual(actual.seats,game.seats);
  assert.equal(result.deltas.reduce((a,b)=>a+b,0),0);
  await t.call(null,'tick');
  assert.equal(t.charges(),1);
});

test('a spectating host starts only with separate host and actual player consent', async () => {
  const t=table(), spec={...game,seats:[null,guest,null,null,null]};
  await t.call(guest,'ready',spec);
  await assert.rejects(t.call(host,'start',spec));
  assert.equal((await t.call(host,'ready',spec)).seat,-1);
  const result=await t.call(host,'start',spec);
  assert.equal(result.seat,-1);
  assert.deepEqual(result.game,result.publicGame);
  const fast = await t.call(host,'pace',{pace:'fast'},at+300);
  assert.equal(fast.pace,'fast');
  assert.equal(fast.dueAt,at+300+Math.round((result.dueAt-at-300)*0.65));
  assert.equal(fast.seat,-1);
  assert.deepEqual(fast.game.hand,[]);
  await assert.rejects(t.call(host,'ready',{...spec,seats:Array(5).fill(null)}));
});

test('a lone original player can settle a missing room, including after an earlier substitution', async () => {
  for (const alreadyLeft of [false,true]) {
    const t = table(), spec = {...game,seats:[host,null,null,null,null]};
    await t.call(host,'ready',spec);
    await t.call(host,'start',spec);
    if (alreadyLeft) {
      const watching = await t.call(host,'leave');
      assert.equal(watching.bots.every(Boolean),true);
      const tick = await t.call(null,'tick',{},at);
      assert.equal(tick.revision,watching.revision);
      assert.equal(t.row().state.finishUnattended,undefined);
    }
    await assert.rejects(t.call(other,'leave',{finishIfAlone:true}),{status:403});
    const left = await t.call(host,'leave',{finishIfAlone:true});
    assert.equal(left.seat,-1);
    for (let batch=0; batch<32 && !t.row().settled; batch++) await t.call(null,'tick');
    const result = await t.call(host,'view');
    assert.ok(result.game.result);
    assert.equal(result.myDelta,result.deltas[0]);
    assert.equal(result.seatBalances[0],120+result.myDelta);
    assert.deepEqual(t.row().seats,spec.seats);
    await t.call(host,'leave',{finishIfAlone:true});
    await t.call(null,'tick');
    assert.equal(t.charges(),1);
  }
});

test('a departure preserves other human turns and overlapping last departures are recoverable', async () => {
  const t = table();
  for (const id of [host,guest]) await t.call(id,'ready',game);
  await t.call(host,'start',game);
  const guestLeft = () => t.call(guest,'leave',{finishIfAlone:true});
  t.beforeNextSave(async () => {
    const watching = await guestLeft();
    assert.deepEqual(watching.bots,[false,true,true,true,true]);
    assert.equal(watching.dueAt,at+120_000);
    assert.equal(watching.turnDeadline,null);
    assert.equal(watching.game.turn,0);
    assert.equal(t.row().state.finishUnattended,undefined);
  });
  await t.call(host,'leave',{finishIfAlone:true});
  for (let batch=0; batch<32 && !t.row().settled; batch++) await t.call(host,'view');
  const result = await t.call(guest,'view');
  assert.ok(result.game.result);
  assert.equal(result.myDelta,result.deltas[1]);
  assert.equal(t.charges(),1);
});

test('a clock tick on a watched all-bot table cannot play ahead of real time', async () => {
  const t = table(), spec = {...game,seats:[host,null,null,null,null]};
  await t.call(host,'ready',spec);
  await t.call(host,'start',spec);
  const watching = await t.call(host,'leave');
  const tick = await t.call(null,'tick',{},watching.dueAt);
  assert.equal(tick.revision,watching.revision+1);
  assert.equal(t.row().state.round.bidHistory.length,1);
  assert.ok(t.row().state.dueAt>watching.dueAt);
  assert.equal((await t.call(null,'tick',{},watching.dueAt)).revision,tick.revision);
});

test('only the host can change pace mid-hand and repeat requests do not restart an AI delay', async () => {
  const t=table(), spec={...game,firstSeat:2};
  for (const id of [host,guest]) await t.call(id,'ready',spec);
  const first = await t.call(host,'start',spec);
  for (const id of [guest,other]) await assert.rejects(t.call(id,'pace',{pace:'fast'}),{status:403});
  await assert.rejects(t.call(null,'pace',{pace:'fast'}),{status:401});
  for (const pace of [undefined,null,'turbo']) await assert.rejects(t.call(host,'pace',{pace}),{status:400});
  const fast = await t.call(host,'pace',{pace:'fast'},at+800);
  assert.equal(fast.revision,first.revision+1);
  assert.equal(fast.dueAt, at+800+650);
  const retry = await t.call(host,'pace',{pace:'fast'},at+1100);
  assert.equal(retry.revision,fast.revision);
  assert.equal(retry.dueAt,fast.dueAt);
  const overdue = await t.call(host,'pace',{pace:'slow'},at+1800);
  assert.equal(overdue.dueAt,fast.dueAt);
  assert.equal((await t.call(null,'watch',{},at+1800)).pace,'slow');
});

test('a host changing pace concurrently with a card preserves the move exactly once', async () => {
  for (const paceWins of [false,true]) {
    const t = table();
    for (const id of [host,guest]) await t.call(id,'ready',game);
    const initial = await t.call(host,'start',game);
    const action = {revision:initial.revision,action:{type:'bid',points:14,suit:'H'}};
    const card = () => t.call(host,'act',action,at+10);
    const setFast = () => t.call(host,'pace',{pace:'fast'},at+10);
    t.beforeNextSave(paceWins ? setFast : card);
    const result = await (paceWins ? card() : setFast());
    assert.equal(result.revision,2);
    assert.equal(result.pace,'fast');
    assert.equal(result.game.bidHistory.length,1);
    assert.equal(result.dueAt,at+10+10_000);
    await t.call(host,'act',action);
    assert.equal(t.row().revision,2);
    // Further settings changes following a real move may not revive the stale input.
    await t.call(host,'pace',{pace:'slow'});
    const retry = await t.call(host,'act',action);
    assert.equal(retry.revision,3);
    assert.equal(retry.game.bidHistory.length,1);
  }
});

test('table pace binds non-default consent and schedules AI turns, keeping the normal legacy manifest', async () => {
  const spec = {...game, firstSeat:2};
  const oldSpec = {host,room:spec.room,seats:spec.seats,names:spec.names,models:spec.models,
    rules:validateRules(spec.rules),firstSeat:spec.firstSeat};
  const oldDigest = Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(oldSpec)))).toString('hex');
  for (const [pace,openingMs] of [['slow',2610],['normal',1800],['fast',1170]]) {
    const t = table();
    await t.call(host,'ready',{...spec,pace});
    await t.call(guest,'ready',pace === 'normal' ? spec : {...spec,pace});
    if (pace !== 'normal') await assert.rejects(t.call(host,'start',spec));
    const opening = await t.call(host,'start',{...spec,pace});
    assert.equal(opening.pace,pace);
    assert.equal(opening.dueAt,at+openingMs);
    assert.equal(t.row().state.manifest === oldDigest,pace === 'normal');
    assert.equal((await t.call(guest,'view')).pace,pace);
    assert.equal((await t.call(null,'watch',{},at+openingMs-1)).revision,0);
    assert.equal((await t.call(null,'watch',{},at+openingMs)).revision,1);
  }
  for (const pace of [null,1,'very-fast','constructor']) {
    await assert.rejects(table().call(host,'ready',{...spec,pace}), /진행 속도/);
  }
});

test('human timeouts are independent of pace and old saved games still have normal timing', async () => {
  for (const pace of ['fast','slow']) {
    const t = table(), spec = {...game,pace};
    for (const id of [host,guest]) await t.call(id,'ready',spec);
    const opening = await t.call(host,'start',spec);
    assert.equal(opening.dueAt,at+10_000);
    const legacy = t.row();
    delete legacy.state.autoPlay;
    delete legacy.state.pace;
    delete legacy.state.turnDeadline;
    legacy.state.dueAt = at+120_000;
    const view = await operateHand({op:'watch',handId},null,{read:()=>legacy},at);
    assert.equal(view.pace,'normal');
    assert.equal(view.autoPlay,true);
    assert.equal(view.turnDeadline,at+10_000);
    assert.equal(view.dueAt,view.turnDeadline);
  }
  const phases = [
    [{phase:'bid',bidHistory:[],dealNo:2},3150],
    [{phase:'bid',bidHistory:[{}]},1350],
    [{phase:'discard'},1910],
    [{phase:'play',trick:[],trickNo:1},2200],
    [{phase:'play',trick:[],trickNo:2},1050],
    [{phase:'play',trick:[{}],trickNo:2},560]
  ];
  for (const [state,base] of phases) {
    assert.equal(botTurnDelay(state),base);
    assert.equal(botTurnDelay(state,'slow'),Math.round(base*1.45));
    assert.equal(botTurnDelay(state,'fast'),Math.round(base*0.65));
  }
  assert.equal(botTurnDelay(phases[0][0],'fast',{showRedeal:false}),tableDelay(1800,'fast'));
});

test('turn assistance is consented to, can be switched live, and keeps the reconnect grace while off', async () => {
  const t = table(), spec = {...game,autoPlay:false};
  for (const id of [host,guest]) await t.call(id,'ready',spec);
  await assert.rejects(t.call(host,'start',game));
  const opening = await t.call(host,'start',spec);
  assert.equal(opening.autoPlay,false);
  assert.equal(opening.turnDeadline,null);
  const before = await t.call(null,'watch',{},at+25_000);
  assert.equal(before.revision,0);
  assert.equal(before.dueAt,at+120_000);
  const present = await t.call(host,'view',{},at+90_000);
  assert.equal(present.dueAt,at+210_000);
  assert.equal((await t.call(null,'tick',{},at+121_000)).revision,present.revision);
  for (const value of [null,0,1,'off']) {
    await assert.rejects(t.call(host,'auto-play',{autoPlay:value}),{status:400});
    await assert.rejects(t.call(host,'ready',{...spec,autoPlay:value}),{status:400});
  }
  await assert.rejects(t.call(guest,'auto-play',{autoPlay:true}),{status:403});
  const enabled = await t.call(host,'auto-play',{autoPlay:true},at+130_000);
  assert.equal(enabled.turnDeadline,at+140_000);
  assert.equal((await t.call(host,'auto-play',{autoPlay:true},at+135_000)).revision,enabled.revision);
  const disabled = await t.call(host,'auto-play',{autoPlay:false},at+139_000);
  assert.equal(disabled.dueAt,at+259_000);
  assert.equal(disabled.turnDeadline,null);
  assert.equal((await t.call(null,'tick',{},at+140_000)).revision,disabled.revision);
  const abandoned = await t.call(null,'watch',{},disabled.dueAt);
  assert.equal(abandoned.bots[0],true);
  assert.equal(abandoned.bots[1],false);
  assert.equal(abandoned.game.bidHistory.length,1);
  assert.equal(abandoned.lastTimedAction,null);
});

test('a manual choice survives multiple refreshes and a concurrent presence renewal while the clock is off', async () => {
  const t = table(), spec = {...game,autoPlay:false};
  for (const id of [host,guest]) await t.call(id,'ready',spec);
  const opening = await t.call(host,'start',spec);
  const action = {revision:opening.revision,action:{type:'bid',points:14,suit:'H'}};
  await t.call(host,'view',{},at+90_000);
  await t.call(host,'pace',{pace:'fast'},at+100_000);
  t.beforeNextSave(() => t.call(host,'view',{},at+170_000));
  const played = await t.call(host,'act',action,at+170_000);
  assert.equal(played.autoPlay,false);
  assert.equal(played.revision,4);
  assert.equal(played.game.bidHistory.length,1);
  assert.equal(played.game.turn,1);
  assert.deepEqual(played.bots,[false,false,true,true,true]);
  await t.call(guest,'view',{},at+260_000);
  const duplicate = await t.call(host,'act',action,at+260_000);
  assert.equal(duplicate.revision,5);
  assert.deepEqual(duplicate.game.bidHistory,played.game.bidHistory);
});

test('a room clock change racing with a human move commits both and preserves any AI time already scheduled', async () => {
  const proof = {term:1,credential:'a'.repeat(64)};
  for (const clockFirst of [true,false]) {
    const t = table();
    for (const id of [host,guest]) await t.call(id,'ready',game);
    await t.call(host,'start',game);
    const action = {revision:0,action:{type:'bid',points:14,suit:'H'}};
    const card = () => t.call(host,'act',action,at+200);
    const turnOff = () => t.call(host,'room-auto-play',{...proof,autoPlay:false},at+200);
    await assert.rejects(t.call(guest,'room-auto-play',{...proof,autoPlay:false}),{status:403});
    t.beforeNextSave(clockFirst ? turnOff : card);
    const result = await (clockFirst ? card() : turnOff());
    assert.equal(result.revision,2);
    assert.equal(result.autoPlay,false);
    assert.equal(result.turnDeadline,null);
    assert.equal(result.game.bidHistory.length,1);
    if (!clockFirst) assert.deepEqual(result.game.hand,[]);
    const passed = await t.call(guest,'act',{revision:2,action:{type:'pass'}},at+20_000);
    const turnOn = await t.call(host,'room-auto-play',{...proof,autoPlay:true},at+20_050);
    assert.equal(turnOn.dueAt,passed.dueAt);
    assert.equal(turnOn.turnDeadline,null);
    assert.equal((await t.call(null,'watch',{},turnOn.dueAt)).game.bidHistory.length,3);
  }
});

test('multiplayer deadline survives reads, invalid input and pace changes; a racing late request plays only once', async () => {
  const t = table();
  for (const id of [host,guest]) await t.call(id,'ready',game);
  const opening = await t.call(host,'start',game);
  const due = opening.turnDeadline;
  assert.equal(opening.serverNow,at);
  assert.equal(opening.lastTimedAction,null);
  await assert.rejects(t.call(host,'act',{revision:0,action:{type:'play'}},due-5),/현재 단계/);
  const fast = await t.call(host,'pace',{pace:'fast'},due-4);
  assert.equal(fast.turnDeadline,due);
  assert.equal((await t.call(host,'view',{},due-1)).game.bidHistory.length,0);
  assert.equal((await t.call(guest,'view',{},due-1)).turnDeadline,due);
  t.beforeNextSave(() => t.call(null,'tick',{},due));
  // The actual expired request is deliberately invalid. It must not be run
  // against the next turn, even when a timer wins the same revision.
  const assisted = await t.call(host,'act',{revision:fast.revision,action:{type:'play'}},due);
  assert.equal(assisted.revision,fast.revision+1);
  assert.deepEqual(assisted.lastTimedAction,{seat:0,revision:assisted.revision});
  assert.equal(assisted.game.bidHistory.length,1);
  assert.equal(assisted.seat,0);
  assert.deepEqual(assisted.bots,opening.bots);
  assert.equal(assisted.turnDeadline,due+10_000);
  assert.equal(assisted.serverNow,due);
  const stale = await t.call(host,'act',{revision:fast.revision,action:{type:'pass'}},due+1);
  assert.deepEqual(stale.lastTimedAction,assisted.lastTimedAction);
  assert.equal(stale.revision,assisted.revision);
  const manual = await t.call(guest,'act',{revision:assisted.revision,action:{type:'pass'}},due+2);
  assert.deepEqual(manual.lastTimedAction,assisted.lastTimedAction);
});

test('timeouts make legal choices at every phase without taking seats, exposing cards or declaring a claim', async () => {
  const t = table(), seats = [host,guest,other,crypto.randomUUID(),crypto.randomUUID()];
  const spec = {...game,seats,models:seats.map(()=>'recurrent_balanced')};
  for (const id of seats) await t.call(id,'ready',spec);
  await t.call(host,'start',spec);
  await t.call(host,'act',{revision:0,action:{type:'bid',points:20,suit:'N'}});
  const phases = new Set();
  for (let i=0;i<60 && !t.row().settled;i++) {
    const {state,revision} = t.row();
    phases.add(state.round.phase);
    const actor = state.round.turn, now = state.dueAt+60_000;
    const next = await t.call(null,'tick',{},now);
    const watching = await t.call(null,'watch',{},now);
    assert.equal(next.revision,revision+1);
    assert.deepEqual(watching.lastTimedAction,{seat:actor,revision:next.revision});
    assert.deepEqual(watching.game.hand,[]);
    assert.deepEqual(watching.bots,[false,false,false,false,false]);
    if (!next.settled) assert.equal(watching.turnDeadline,now+10_000);
  }
  assert.deepEqual([...phases].sort(),['bid','discard','friend','play']);
  assert.equal(t.charges(),1);
  const result = await t.call(host,'view');
  assert.equal(result.seat,0);
  assert.equal(result.turnDeadline,null);
  assert.equal(result.game.result.setting,undefined);
});

test('a solo seat keeps its two-minute reconnection window and can renew it while thinking', async () => {
  const t = table(), spec = {...game,seats:[host,null,null,null,null]};
  await t.call(host,'ready',spec);
  const opening = await t.call(host,'start',spec);
  assert.equal(opening.turnDeadline,null);
  assert.equal(opening.dueAt,at+120_000);
  const active = await t.call(host,'view',{},at+90_000);
  assert.equal(active.dueAt,at+210_000);
  assert.equal(active.game.bidHistory.length,0);
  await t.call(null,'tick',{},active.dueAt);
  const abandoned = await t.call(host,'view',{},active.dueAt);
  assert.equal(abandoned.seat,-1);
  assert.equal(abandoned.lastTimedAction,null);
});

test('HTTP handler authenticates against Auth and keeps its privileged credential out of user requests',async () => {
  const seen=[];
  let confirmed=false;
  const handler=chipHandler({url:'https://example.invalid',publicKey:'public',serviceKey:'private',
    send:async (url, options) => {
      seen.push({url,...options});
      if(url.endsWith('/auth/v1/user')) return Response.json({id:guest,email:'a@example.invalid',email_confirmed_at:confirmed?'now':null});
      return Response.json(null);
    }});
  const post=(body, token) => handler(new Request('https://edge.invalid', {method:'POST',
    headers:token?{Authorization:'Bearer '+token}:{},body:JSON.stringify(body)}));
  assert.equal((await post({op:'active',userId:host})).status,401);
  assert.equal((await post({op:'active',userId:host},'user')).status,403);
  confirmed=true;
  assert.deepEqual(await (await post({op:'active',userId:host},'user')).json(),{handId:null});
  assert.equal(seen.at(-1).headers.Authorization,'Bearer user');
  assert.equal(seen.at(-1).headers.apikey,'public');
  assert.equal((await post({op:'watch',handId})).status,404);
  assert.equal(seen.at(-1).headers.apikey,'private');
});
