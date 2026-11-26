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
  const departed = await t.call(host,'view'), timedOut = await t.call(guest,'view');
  assert.equal(departed.seat,-1);
  assert.equal(departed.myDelta,result.deltas[0]);
  assert.equal(timedOut.myDelta,result.deltas[1]);
  assert.equal((await t.call(host,'watch')).myDelta,undefined);
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
    delete legacy.state.pace;
    delete legacy.state.turnDeadline;
    legacy.state.dueAt = at+120_000;
    const view = await operateHand({op:'watch',handId},null,{read:()=>legacy},at);
    assert.equal(view.pace,'normal');
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
