import test from 'node:test';
import assert from 'node:assert/strict';
import {operateLobby} from '../supabase/functions/public-lobby/lobby.js';
import {lobbyHandler} from '../supabase/functions/public-lobby/handler.js';
import {createGame,getSpectatorView} from '../table-deal.js';

const founder = {name:'별',credential:'a'.repeat(64),id:crypto.randomUUID()};
const guest = {name:'달',credential:'b'.repeat(64),id:crypto.randomUUID()};
const observer = {name:'구름',credential:'c'.repeat(64),id:null};

function lobby() {
  let time = 1000, row = {roomId:null,revision:0,state:null,legacy:false}, hand;
  const archive = [], starts = [], leaves = [], links = [];
  const api = {
    async read() { return structuredClone(row); },
    async commit({p_revision,p_state,p_room_id,p_message,p_hand}) {
      if (row.revision !== p_revision) return {applied:false};
      if (p_message) archive.push(p_message);
      if (p_hand) links.push(p_hand);
      row = {...row,revision:p_revision+1,state:structuredClone(p_state),roomId:p_state ? p_room_id : null};
      return {revision:row.revision,applied:true};
    },
    canPlay:async () => {},
    chips:{
      async start(spec) {
        assert.equal(row.state.offer.status,'starting');
        assert.equal(row.state.offer.manifest.length,64);
        assert.deepEqual(links.at(-1),{id:spec.handId,hostId:spec.host});
        if (!hand) {
          starts.push(spec);
          hand = {handId:spec.handId,revision:0,bots:spec.seats.map(id => !id),pace:'normal',autoPlay:true,
            publicGame:getSpectatorView(createGame({rules:spec.rules,firstSeat:spec.firstSeat}))};
        }
        return hand;
      },
      async read() {return hand;},
      async leave(handId,accountId,finish) {leaves.push([handId,accountId,finish]);},
    },
  };
  const call = (user,op,fields = {}) => operateLobby({slot:2,credential:user.credential,name:user.name,
    roomId:row.roomId,requestId:crypto.randomUUID(),op,after:0,...fields},user.id,api,()=>time);
  return {call,api,archive,starts,leaves,get row() {return row;},elapse(ms) {time+=ms;}};
}

test('public lobby handles concurrent joins, seating, authority, transfers and stale room editions',async () => {
  const l = lobby();
  await assert.rejects(l.call(observer,'join'),{status:401});
  const [host,visitor] = await Promise.all([l.call(founder,'join'),l.call(guest,'join')]);
  assert.equal(host.roomId,visitor.roomId);
  assert.notEqual(host.isHost,visitor.isHost);
  const first = host.isHost ? founder : guest, second = host.isHost ? guest : founder;
  await l.call(observer,'join');
  await assert.rejects(l.call(observer,'seat',{target:1,revision:0}),{status:401});
  await assert.rejects(l.call(second,'settings',{key:'pace',value:'fast'}),{status:403});
  const before = await l.call(first,'poll');
  await l.call(first,'seat',{target:1,revision:before.view.revision});
  const seated = await l.call(second,'reserve',{wanted:true});
  const swapped = await l.call(second,'swap',{target:1,revision:seated.view.revision});
  const done = await l.call(first,'swap-answer',{accepted:true,revision:swapped.view.revision});
  assert.equal(done.view.players[1].name,second.name);
  await l.call(first,'leave');
  assert.equal((await l.call(second,'poll')).isHost,true);
  assert.equal(l.row.state.controlTerm,2);
  const oldRoom = l.row.roomId;
  await l.call(second,'leave');
  assert.equal((await l.call(observer,'poll')).isHost,true);
  const promoted = await l.call(founder,'join');
  assert.equal(promoted.isHost,true);
  assert.equal((await l.call(observer,'poll')).view.spectator,true);
  await l.call(founder,'leave');
  await l.call(observer,'leave');
  assert.equal(l.row.state,null);
  assert.notEqual((await l.call(founder,'join')).roomId,oldRoom);
  await assert.rejects(l.call(second,'poll',{roomId:oldRoom}),{code:'LOBBY_ROOM_CHANGED'});
});

test('chat is archived once and delivered only for the current visit',async () => {
  const l = lobby();
  await l.call(founder,'join');
  const requestId = crypto.randomUUID();
  await l.call(founder,'chat',{text:'먼저 보낸 메시지',requestId});
  await l.call(founder,'chat',{text:'먼저 보낸 메시지',requestId});
  assert.equal(l.archive.length,1);
  const entrant = await l.call(observer,'join');
  assert.deepEqual(entrant.messages,[]);
  l.elapse(1000);
  await l.call(founder,'chat',{text:'지금 보낸 메시지'});
  const delivered = await l.call(observer,'poll',{after:0});
  assert.deepEqual(delivered.messages.map(m => [m.id,m.text,m.own]),[[2,'지금 보낸 메시지',false]]);
  await l.call(observer,'join');
  assert.deepEqual((await l.call(observer,'poll',{after:0})).messages,[]);
  assert.ok(!JSON.stringify(delivered).includes(l.row.state.controlKey));
  assert.ok(!JSON.stringify(delivered).includes(Object.keys(l.row.state.members)[0]));
  assert.ok(!JSON.stringify(delivered).includes(founder.id));
});

test('a legacy public table finishes its signed offer with the fixed clock and drops queued clock edits',async () => {
  const l = lobby();
  const joined = await l.call(founder,'join',{preferences:{autoPlay:false}});
  assert.equal(joined.view.autoPlay,true);
  await l.call(founder,'reserve',{wanted:true});
  assert.equal((await l.call(founder,'settings',{key:'autoPlay',value:false})).view.autoPlay,true);
  const {offer} = await l.call(founder,'start');
  assert.equal(Object.hasOwn(offer,'autoPlay'),false);
  l.row.state.session.autoPlay = false;
  l.row.state.offer.spec.autoPlay = false;
  const pending = await l.call(founder,'poll');
  assert.equal(pending.offer.handId,offer.handId);
  assert.equal(pending.offer.autoPlay,false);
  assert.equal(pending.view.autoPlay,false,'a cached client can confirm the exact pending manifest');
  const started = await l.call(founder,'ready',{accepted:true,handId:offer.handId});
  assert.equal(started.view.autoPlay,true);
  assert.equal(l.starts[0].handId,offer.handId);
  l.row.state.effects.push({op:'setting',id:crypto.randomUUID(),handId:offer.handId,key:'autoPlay',value:false});
  l.api.chips.setting = assert.fail;
  assert.equal((await l.call(founder,'poll')).view.autoPlay,true);
  assert.deepEqual(l.row.state.effects,[]);
  assert.equal((await l.call(founder,'settings',{key:'autoPlay',value:false})).view.autoPlay,true);
});

test('fresh visitor can reopen an expired edition and active guests take over without the founder',async () => {
  const l = lobby();
  const a = await l.call(founder,'join');
  await l.call(guest,'join');
  l.elapse(90_000);
  await l.call(guest,'poll');
  l.elapse(31_000);
  assert.equal((await l.call(guest,'poll')).isHost,true);
  await assert.rejects(l.call(founder,'poll'),{code:'LOBBY_MEMBERSHIP_EXPIRED'});
  l.elapse(121_000);
  assert.notEqual((await l.call(founder,'join')).roomId,a.roomId);
});

test('deals start after durable participant consent and preserve ownership on departure',async () => {
  const l = lobby();
  await l.call(founder,'join');
  await l.call(guest,'join');
  await l.call(observer,'join');
  await l.call(founder,'reserve',{wanted:true});
  await l.call(guest,'reserve',{wanted:true});
  const offered = await l.call(founder,'start');
  await l.call(observer,'reserve',{wanted:false});
  const handId = offered.offer.handId;
  assert.equal((await l.call(observer,'poll')).offer,null);
  await l.call(founder,'ready',{accepted:true,handId});
  assert.equal(l.starts.length,0);
  const started = await l.call(guest,'ready',{accepted:true,handId});
  assert.equal(l.starts.length,1);
  assert.equal(started.view.chipHandId,handId);
  const watched = await l.call(observer,'poll');
  assert.deepEqual(watched.view.game.hand,[]);
  assert.equal(watched.view.game.seat,-1);
  await l.call(founder,'depart',{handId,wanted:true});
  assert.equal((await l.call(founder,'poll')).view.departing,true);
  await l.call(founder,'leave');
  assert.deepEqual(l.leaves,[[handId,founder.id,false]]);
  assert.equal((await l.call(guest,'poll')).isHost,true);
  const newcomer = await l.call(founder,'join');
  assert.equal(newcomer.view.spectator,true);
  assert.equal((await l.call(founder,'reserve',{wanted:true})).view.reservation.position,1);
  await l.call(guest,'watch');
  assert.deepEqual(l.leaves.at(-1),[handId,guest.id,false]);
  await l.call(guest,'leave');
  await l.call(founder,'leave');
  await l.call(observer,'leave');
  assert.deepEqual(l.leaves.at(-1),[handId,founder.id,true]);
  assert.equal(l.row.state.host,null);
});

test('an unchanged chip revision skips a second hand read while active',async () => {
  const l = lobby();
  await l.call(founder,'join');
  await l.call(founder,'reserve',{wanted:true});
  const offer = (await l.call(founder,'start')).offer;
  await l.call(founder,'ready',{accepted:true,handId:offer.handId});
  const savedRead = l.api.chips.read;
  let reads = 0;
  l.api.chips.read = async id => {reads++; return savedRead(id);};
  l.api.read = async () => ({...structuredClone(l.row),chipRevision:l.row.state.session.chipRevision});
  await l.call(founder,'poll');
  assert.equal(reads,0);
  l.api.read = async () => ({...structuredClone(l.row),chipRevision:l.row.state.session.chipRevision+1});
  await l.call(founder,'poll');
  assert.equal(reads,1);
});

test('a jsonb-equivalent checkpoint does not write for idle polls',async () => {
  const l = lobby();
  await l.call(founder,'join');
  const revision = l.row.revision;
  function reverse(value) {
    if (Array.isArray(value)) return value.map(reverse);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reverse(v)]));
    return value;
  }
  l.api.read = async () => reverse(l.row);
  await l.call(founder,'poll',{requestId:null});
  assert.equal(l.row.revision,revision);
});

test('public lobby rejects invalid user tokens before service-role access',async () => {
  const urls = [];
  const handler = lobbyHandler({url:'https://test.invalid',publicKey:'publishable',serviceKey:'secret',
    send:async (url,init) => {urls.push(url); assert.equal(init.headers.apikey,'publishable'); return new Response('{}',{status:401});}});
  const response = await handler(new Request('https://test.invalid/functions/v1/public-lobby',{method:'POST',
    headers:{Authorization:'Bearer expired'},body:JSON.stringify({slot:1,op:'join'})}));
  assert.equal(response.status,401);
  assert.deepEqual(urls,['https://test.invalid/auth/v1/user']);
});
