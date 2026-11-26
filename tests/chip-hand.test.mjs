import test from 'node:test';
import assert from 'node:assert/strict';
import {operateHand} from '../supabase/functions/chip-hand/hand.js';
import {chipHandler} from '../supabase/functions/chip-hand/handler.js';
import {settlements} from '../table-scoring.js';

const host = 'b11255ac-bd23-4fd4-af36-aaaaaaaaaaaa';
const guest = 'b11255ac-bd23-4fd4-af36-bbbbbbbbbbbb';
const other = 'b11255ac-bd23-4fd4-af36-dddddddddddd';
const handId = '835d7a38-0db9-4a32-b721-6232d8ca3844';
const game = {handId, host, room:'TABLE2', seats:[host,guest,null,null,null],
  names:['방장','친구','AI 별','AI 구름','AI 바다'], models:Array(5).fill('heuristic'), firstSeat:0};
const at = 1_800_000_000_000;

function table() {
  let row = null, charges = 0;
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
          row = {hand, room:spec.room, host:spec.host, seats:spec.seats, revision:0, state:clone(state), settled:false};
        }
        return clone(row);
      },
      read:() => clone(row),
      save(update) {
        if (row.revision === update.revision && !row.settled) {
          row = {...clone(update), revision:row.revision+1, settled:Boolean(update.state.round.result)};
          if (row.settled) charges++;
        }
        return clone(row);
      }
    };
    return operateHand({handId, op, ...fields}, id, db, now);
  }
  return {call, row:() => clone(row), charges:() => charges};
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
  assert.deepEqual((await t.call(host,'start',game)).game.hand,first.game.hand);
  const second = await t.call(guest,'view');
  assert.ok(second.game.hand.every(c => !first.game.hand.includes(c)));
  assert.equal(second.publicGame,undefined);
  const watcher = await t.call(host,'watch');
  assert.deepEqual(watcher.game.hand,[]);
  assert.equal(watcher.game.selfRole,'spectator');
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
  const dealt = await t.call(host,'start',game);
  // Browsing holds the thinking player's seat. An explicit departure cannot
  // reclaim its private view, and cannot move or debit a different account.
  const heartbeat = await t.call(host,'view',{},at+90_000);
  assert.ok(heartbeat.dueAt > dealt.dueAt);
  assert.equal(heartbeat.seat,0);
  const left = await t.call(host,'leave',{seat:1},at+90_001);
  assert.deepEqual(left.bots,[true,false,true,true,true]);
  assert.equal(left.seat,-1);
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
  await assert.rejects(t.call(host,'ready',{...spec,seats:Array(5).fill(null)}));
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
