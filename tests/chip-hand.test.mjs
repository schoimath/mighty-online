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
  const opening = await t.call(host,'start',game);
  // A returning player may still control their seat after a timed-out action.
  const resumed = await t.call(host,'view',{},opening.turnDeadline);
  assert.equal(resumed.game.bidHistory.length,1);
  assert.equal(resumed.seat,0);
  const left = await t.call(host,'leave',{seat:1},opening.turnDeadline+1);
  assert.deepEqual(left.bots,[true,false,true,true,true]);
  assert.deepEqual(left.seatBalances,[null,300,null,null,null]);
  assert.equal(left.seat,-1);
  assert.equal(left.turnDeadline,resumed.turnDeadline);
  assert.equal(left.myDelta,undefined);
  assert.equal(left.mySettlementSeat,undefined);
  assert.deepEqual(left.game.hand,[]);
  await assert.rejects(t.call(host,'act',{revision:left.revision,action:{type:'pass'}}),{status:403});
  for (let i=0; i<100 && !t.row().settled; i++) {
    await t.call(null,'tick',{p_deltas:[500,0,0,0,0]},opening.turnDeadline+(i+1)*180_000);
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
    assert.equal(watching.dueAt,at+190_000);
    assert.equal(watching.turnDeadline,at+190_000);
    assert.equal(t.row().state.dueAt,at+120_000);
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
    assert.equal(result.dueAt,at+10+190_000);
    assert.deepEqual(t.row().state.thinkingTime,[179_990,180_000,0,0,0]);
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
    assert.equal(opening.timeBankMs,180_000);
    assert.equal(opening.thinkingDeadline,at+180_000);
    assert.equal(opening.dueAt,at+190_000);
    const legacy = t.row();
    delete legacy.state.autoPlay;
    delete legacy.state.pace;
    delete legacy.state.thinkingTime;
    delete legacy.state.turnDeadline;
    legacy.state.dueAt = at+120_000;
    const view = await operateHand({op:'watch',handId},null,{read:()=>legacy,save:row=>({...row,revision:row.revision+1})},at);
    assert.equal(view.pace,'normal');
    assert.equal(view.autoPlay,true);
    assert.equal(view.timeBankMs,180_000);
    assert.equal(view.thinkingDeadline,at+180_000);
    assert.equal(view.turnDeadline,at+190_000);
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

test('old offers bind their original consent but all new multiplayer hands run the fixed clock', async () => {
  const t = table(), spec = {...game,autoPlay:false};
  for (const id of [host,guest]) await t.call(id,'ready',spec);
  await assert.rejects(t.call(host,'start',game));
  const opening = await t.call(host,'start',spec);
  assert.equal(opening.autoPlay,true);
  assert.equal(opening.thinkingDeadline,at+180_000);
  assert.equal(opening.turnDeadline,at+190_000);
  assert.deepEqual(opening.seatTimeBanks,[180_000,180_000,null,null,null]);
  for (const value of [null,0,1,'off']) {
    await assert.rejects(t.call(host,'auto-play',{autoPlay:value}),{status:400});
    await assert.rejects(t.call(host,'ready',{...spec,autoPlay:value}),{status:400});
  }
  await assert.rejects(t.call(guest,'auto-play',{autoPlay:true}),{status:403});
  const oldToggle = await t.call(host,'auto-play',{autoPlay:false},at+130_000);
  assert.equal(oldToggle.autoPlay,true);
  assert.equal(oldToggle.revision,opening.revision);
  assert.equal(oldToggle.turnDeadline,opening.turnDeadline);
  assert.deepEqual(oldToggle.seatTimeBanks,[50_000,180_000,null,null,null]);
});

test('each player spends only their own reserve across bidding, declaring and playing', async () => {
  const seats = [host,guest,other,crypto.randomUUID(),crypto.randomUUID()];
  for (const combined of [false,true]) {
    const t = table(), spec = {...game,seats};
    for (const id of seats) await t.call(id,'ready',spec);
    await t.call(host,'start',spec);
    const act = (id,action,elapsed) => t.call(id,'act',{revision:t.row().revision,action},at+elapsed);
    const guestTurn = await act(host,{type:'bid',points:20,suit:'N'},30_000);
    assert.equal(guestTurn.thinkingDeadline,at+210_000);
    for (let i=1;i<5;i++) await act(seats[i],{type:'pass'},40_000+i*1000);
    const prep = await t.call(host,'view',{},at+44_000);
    assert.equal(prep.game.phase,'discard');
    assert.deepEqual(t.row().state.thinkingTime,[150_000,169_000,179_000,179_000,179_000]);
    assert.equal(prep.thinkingDeadline,at+194_000);
    const cards = prep.game.hand.slice(0,3);
    let play;
    if (combined) {
      play = await act(host,{type:'prepare',cards,contract:prep.game.bid,friend:{kind:'none'}},84_000);
    } else {
      const friend = await act(host,{type:'discard',cards,contract:prep.game.bid},74_000);
      assert.equal(friend.thinkingDeadline,prep.thinkingDeadline);
      play = await act(host,{type:'friend',kind:'none'},84_000);
    }
    assert.equal(play.game.phase,'play');
    assert.equal(play.thinkingDeadline,prep.thinkingDeadline);
    await act(host,{type:'play',...play.game.choices.plays[0]},94_000);
    assert.deepEqual(t.row().state.thinkingTime,[100_000,169_000,179_000,179_000,179_000]);
  }
});

test('a paused pre-update hand resumes its remaining overtime once even across racing reads',async () => {
  const t = table();
  for (const id of [host,guest]) await t.call(id,'ready',game);
  await t.call(host,'start',game);
  let legacy = t.row(), changed=0;
  Object.assign(legacy.state,{autoPlay:false,thinkingTime:[0,143000,0,0,0],pausedOvertimeMs:3000,turnDeadline:null,dueAt:at+120_000});
  const db = {read:()=>structuredClone(legacy),save:row=>{
    if (row.revision===legacy.revision) {legacy={...structuredClone(row),revision:row.revision+1}; changed++;}
    return structuredClone(legacy);
  }};
  const resumed = await Promise.all([at+200_000,at+200_010].map(now=>
    operateHand({op:'view',handId},host,db,now)));
  const due = resumed[0].turnDeadline;
  assert.equal(due,at+203000);
  assert.equal(changed,1);
  for (const view of resumed) {
    assert.equal(view.autoPlay,true);
    assert.equal(view.turnDeadline,due);
    assert.deepEqual(view.seatTimeBanks,[0,143000,null,null,null]);
    assert.equal(view.game.bidHistory.length,0);
  }
  // The old tab may submit the bid with the revision it had while paused.
  const moved=await operateHand({op:'act',handId,revision:0,action:{type:'pass'}},host,db,due-1);
  assert.equal(moved.game.bidHistory.length,1);
  assert.equal(moved.lastTimedAction,null);
  assert.equal(moved.turnDeadline,due-1+153000);
});

test('other departures preserve the current deadline and reserve even when only one human remains', async () => {
  const t = table(), spec = {...game,seats:[host,guest,other,null,null]};
  for (const id of [host,guest,other]) await t.call(id,'ready',spec);
  const opening = await t.call(host,'start',spec);
  const stillTimed = await t.call(other,'leave',{},at+20_000);
  assert.equal(stillTimed.turnDeadline,opening.turnDeadline);
  assert.equal(stillTimed.thinkingDeadline,opening.thinkingDeadline);
  const solo = await t.call(guest,'leave',{},at+35_000);
  assert.equal(solo.turnDeadline,opening.turnDeadline);
  assert.equal(solo.thinkingDeadline,opening.thinkingDeadline);
  assert.deepEqual(solo.seatTimeBanks,[145_000,null,null,null,null]);
  assert.equal(t.row().state.dueAt,at+155_000);
  await t.call(host,'act',{revision:solo.revision,action:{type:'bid',points:14,suit:'H'}},at+100_000);
  assert.equal(t.row().state.thinkingTime[0],80_000);
});

test('an all-pass redeal keeps each reserve within the same scored hand', async () => {
  const seats = [host,guest,other,crypto.randomUUID(),crypto.randomUUID()], t = table();
  const spec = {...game,seats};
  for (const id of seats) await t.call(id,'ready',spec);
  const opening = await t.call(host,'start',spec);
  let current = opening;
  for (let i=1;i<=5;i++) {
    current = await t.call(seats[current.game.turn],'act',{revision:current.revision,action:{type:'pass'}},at+i*2000);
  }
  assert.equal(current.game.dealNo,opening.game.dealNo+1);
  assert.deepEqual(t.row().state.thinkingTime,Array(5).fill(178_000));
  assert.equal(current.thinkingDeadline,at+188_000);
});

test('a live hand from before time banks existed receives full personal reserves exactly once', async () => {
  const t = table();
  for (const id of [host,guest]) await t.call(id,'ready',game);
  await t.call(host,'start',game);
  let legacy = t.row();
  delete legacy.state.thinkingTime;
  legacy.state.turnDeadline = legacy.state.dueAt = at+10_000;
  const db = {read:() => structuredClone(legacy), save:row => {
    legacy = {...structuredClone(row),revision:row.revision+1};
    return structuredClone(legacy);
  }};
  const resumed = await operateHand({op:'view',handId},host,db,at+12_000);
  assert.equal(resumed.timeBankMs,180_000);
  assert.equal(resumed.turnDeadline,at+202_000);
  assert.equal(resumed.thinkingDeadline,at+192_000);
  assert.deepEqual(resumed.seatTimeBanks,[180_000,180_000,null,null,null]);
  const passed = await operateHand({op:'act',handId,revision:0,action:{type:'pass'}},host,db,at+20_000);
  assert.equal(passed.turnDeadline,at+210_000);
  assert.equal(passed.thinkingDeadline,at+200_000);
  assert.equal(passed.game.turn,1);
  assert.deepEqual(legacy.state.thinkingTime,[172_000,180_000,0,0,0]);
});

test('public seat clocks charge exactly once and a new turn spends only that seat’s reserve', async () => {
  const t = table();
  for (const id of [host,guest]) await t.call(id,'ready',game);
  const opening = await t.call(host,'start',game);
  const watching = await t.call(null,'watch',{},at+25_000);
  assert.deepEqual(watching.seatTimeBanks,[155_000,180_000,null,null,null]);
  assert.equal(watching.revision,opening.revision);
  assert.deepEqual(t.row().state.thinkingTime,[180_000,180_000,0,0,0]);
  const guestTurn=await t.call(host,'act',{revision:0,action:{type:'pass'}},at+30_000);
  assert.deepEqual(guestTurn.seatTimeBanks,[150_000,180_000,null,null,null]);
  const botTurn=await t.call(guest,'act',{revision:guestTurn.revision,action:{type:'pass'}},at+70_000);
  assert.deepEqual(botTurn.seatTimeBanks,[150_000,140_000,null,null,null]);
  assert.equal(botTurn.turnDeadline,null);
});

test('a deprecated room clock request cannot change a turn or override host control authorization', async () => {
  const proof = {term:1,credential:'a'.repeat(64)}, t = table();
  for (const id of [host,guest]) await t.call(id,'ready',game);
  const opening = await t.call(host,'start',game);
  await assert.rejects(t.call(guest,'room-auto-play',{...proof,autoPlay:false}),{status:403});
  const response = await t.call(host,'room-auto-play',{...proof,autoPlay:false},at+300);
  assert.deepEqual(response.game.hand,[]);
  assert.equal(response.revision,0);
  assert.equal(response.turnDeadline,opening.turnDeadline);
  assert.equal(response.autoPlay,true);
  const played = await t.call(host,'act',{revision:0,action:{type:'bid',points:14,suit:'H'}},at+1000);
  const bot = await t.call(guest,'act',{revision:played.revision,action:{type:'pass'}},at+2000);
  const unchanged = await t.call(host,'room-auto-play',{...proof,autoPlay:true},at+2200);
  assert.equal(unchanged.dueAt,bot.dueAt);
  assert.equal(unchanged.turnDeadline,null);
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
  assert.equal(assisted.thinkingDeadline,due+180_000);
  assert.equal(assisted.turnDeadline,due+190_000);
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
  const exhausted = new Set();
  for (let i=0;i<60 && !t.row().settled;i++) {
    const {state,revision} = t.row();
    phases.add(state.round.phase);
    const actor = state.round.turn, now = state.dueAt+60_000;
    const next = await t.call(null,'tick',{},now);
    const watching = await t.call(null,'watch',{},now);
    exhausted.add(actor);
    assert.equal(next.revision,revision+1);
    assert.deepEqual(watching.lastTimedAction,{seat:actor,revision:next.revision});
    assert.deepEqual(watching.game.hand,[]);
    assert.deepEqual(watching.bots,[false,false,false,false,false]);
    if (!next.settled) {
      const hasTime = !exhausted.has(watching.game.turn);
      assert.equal(watching.thinkingDeadline,hasTime ? now+180_000 : null);
      assert.equal(watching.turnDeadline,now+(hasTime ? 190_000 : 10_000));
    }
  }
  assert.deepEqual([...phases].sort(),['bid','discard','friend','play']);
  assert.equal(t.charges(),1);
  const result = await t.call(host,'view');
  assert.equal(result.seat,0);
  assert.equal(result.turnDeadline,null);
  assert.equal(result.game.result.setting,undefined);
});

test('the solo bank runs through authenticated reads; its expiry assists once and subsequent turns get ten seconds', async () => {
  const t = table(), spec = {...game,seats:[host,null,null,null,null]};
  await t.call(host,'ready',spec);
  const opening = await t.call(host,'start',spec);
  assert.equal(opening.turnDeadline,at+190_000);
  assert.deepEqual(opening.seatTimeBanks,[180_000,null,null,null,null]);
  assert.equal(t.row().state.dueAt,at+120_000);
  const active = await t.call(host,'view',{},at+90_000);
  assert.equal(active.turnDeadline,opening.turnDeadline);
  assert.deepEqual(active.seatTimeBanks,[90_000,null,null,null,null]);
  assert.equal(active.game.bidHistory.length,0);
  await t.call(null,'tick',{},at+120_000);
  assert.equal(t.row().revision,active.revision);
  t.beforeNextSave(() => t.call(null,'tick',{},opening.turnDeadline));
  const assisted = await t.call(host,'act',{revision:0,action:{type:'play'}},opening.turnDeadline);
  assert.deepEqual(assisted.lastTimedAction,{seat:0,revision:assisted.revision});
  assert.equal(assisted.seat,0);
  assert.equal(assisted.game.bidHistory.length,1);
  assert.deepEqual(assisted.seatTimeBanks,[0,null,null,null,null]);
  let turn = assisted;
  for (let i = 0; i < 70 && turn.game.turn !== 0; i++) turn = await t.call(host,'view',{},turn.dueAt);
  assert.equal(turn.game.turn,0);
  assert.equal(turn.turnDeadline,turn.serverNow+10_000);
  const next = await t.call(host,'view',{},turn.turnDeadline);
  assert.deepEqual(next.lastTimedAction,{seat:0,revision:next.revision});
  assert.equal(next.seat,0);
});

test('spectators cannot renew a missing sole player; AI completes their original hand', async () => {
  const t = table(), spec = {...game,seats:[host,null,null,null,null]};
  await t.call(host,'ready',spec);
  await t.call(host,'start',spec);
  const until = t.row().state.soloPresenceUntil;
  await t.call(null,'watch',{},until-1);
  await t.call(null,'tick',{},until);
  const abandoned = await t.call(host,'view',{},until);
  assert.equal(abandoned.seat,-1);
  assert.equal(abandoned.lastTimedAction,null);
  assert.deepEqual(abandoned.seatTimeBanks,Array(5).fill(null));
  for (let i=1; i<=100 && !t.row().settled; i++) await t.call(null,'tick',{},until+i*60_000);
  const result = await t.call(host,'view');
  assert.equal(result.myDelta,result.deltas[0]);
  assert.equal(t.charges(),1);
});

test('an active legacy solo hand initializes its clock once and keeps remaining reserve', async () => {
  const t = table(), spec = {...game,seats:[host,null,null,null,null]};
  await t.call(host,'ready',spec);
  await t.call(host,'start',spec);
  let old = t.row();
  delete old.state.soloPresenceUntil;
  old.state.turnDeadline = null;
  old.state.thinkingTime[0] = 34_000;
  const db = {read:()=>structuredClone(old),save:row=>{
    if (row.revision===old.revision) old={...structuredClone(row),revision:row.revision+1};
    return structuredClone(old);
  }};
  const read = now => operateHand({op:'view',handId},host,db,now);
  const [first,second] = await Promise.all([read(at+10_000),read(at+12_000)]);
  assert.equal(first.revision,1);
  assert.equal(second.revision,1);
  assert.equal(second.turnDeadline,first.turnDeadline);
  assert.equal(first.turnDeadline,at+54_000);
  assert.deepEqual(second.seatTimeBanks,[32_000,null,null,null,null]);
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
