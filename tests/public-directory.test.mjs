import assert from 'node:assert/strict';
import test from 'node:test';
import {listPublicRooms,reserveDirectoryRoom,watchDirectoryRoom,PUBLIC_ROOM_LIMIT,PRIVATE_ROOM_LIMIT} from '../public-directory.js';

const client={url:'https://example.invalid',publishableKey:'test-public',state:{user:{id:'member'}},accessToken:async()=>'member-token'};
const store={id:'archive',credential:'controller',term:1};
const names=['스페이드 테이블','하트 테이블','다이아 테이블','클로버 테이블'];
const slots=names.map((name,i)=>({slot:i+1,name,code:'PUB00'+(i+1),phase:'empty'}));
const summary={phase:'waiting',hostName:'방장',humanCount:2,spectatorCount:0,reservationCount:0,roundNumber:1,roundLimit:10};

function transport(t,handler) {
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if (options.signal.aborted) throw options.signal.reason;
    const entry={operation:url.split('mighty_directory_').pop(),args:JSON.parse(options.body),headers:options.headers};
    calls.push(entry);
    const value=await handler(entry,calls.length);
    return value instanceof Response ? value : new Response(value==null ? null : JSON.stringify(value));
  });
  return calls;
}

test('the public list contains the four permanent tables and does not send account authorization',async t=>{
  const calls=transport(t,()=>slots);
  assert.equal(PUBLIC_ROOM_LIMIT,4);
  assert.equal(PRIVATE_ROOM_LIMIT,6);
  assert.deepEqual(await listPublicRooms({client}),slots);
  assert.deepEqual(calls[0],{operation:'list',args:{},headers:{apikey:'test-public','Content-Type':'application/json'}});
  const cancelled=new AbortController();
  cancelled.abort();
  await assert.rejects(listPublicRooms({client,signal:cancelled.signal}),{name:'AbortError'});
  assert.equal(calls.length,1);
});

test('an incomplete or malformed directory cannot replace the last valid lobby listing',async t=>{
  const responses=[slots.slice(0,3),slots.map((r,i)=>i===2 ? {...r,code:'PRIV01'} : r)];
  transport(t,()=>responses.shift());
  await assert.rejects(listPublicRooms({client}),/목록/);
  await assert.rejects(listPublicRooms({client}),/목록/);
});

test('a public reservation loser gets the same code; private creation uses an unnamed slot and the explicit title',async t=>{
  const responses=[{claimed:false,slot:2,code:'PUB002'},{claimed:true,slot:5,code:'INVITE'},
    new Response(JSON.stringify({code:'P0001',message:'비공개 방 6개가 모두 열려 있습니다.'}),{status:400})];
  const calls=transport(t,()=>responses.shift());
  const join=await reserveDirectoryRoom(client,{store,code:'PUB002',slot:2,hostName:'지현'});
  assert.deepEqual(join,{claimed:false,slot:2,code:'PUB002'});
  assert.deepEqual(await reserveDirectoryRoom(client,{store,code:'INVITE',name:'친구들',hostName:'지현'}),
    {claimed:true,slot:5,code:'INVITE'});
  assert.deepEqual(calls[1].args,{p_room_id:store.id,p_credential:store.credential,p_code:'INVITE',p_slot:null,p_name:'친구들',p_host:'지현'});
  assert.equal(calls[1].headers.Authorization,'Bearer member-token');
  await assert.rejects(reserveDirectoryRoom(client,{store,code:'PRIV07',hostName:'지현'}),/6개/);
});

test('directory refresh sends changed public fields only, heartbeats a quiet room and stops without closing on handoff',async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:10000});
  const calls=transport(t,()=>null);
  let view={...summary,hand:['SA'],chipId:'private',email:'private'};
  const original=watchDirectoryRoom(client,{store,getSummary:()=>view});
  t.after(()=>original.stop());
  await original.refresh();
  await original.refresh();
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].args,{p_room_id:'archive',p_credential:'controller',p_term:1,p_summary:summary});
  view={...view,phase:'playing',spectatorCount:1};
  await original.refresh();
  assert.equal(calls.length,2);
  t.mock.timers.tick(20000);
  await original.refresh();
  assert.equal(calls.length,3);
  original.stop();
  t.mock.timers.tick(60000);
  await original.refresh();
  assert.equal(calls.length,3);
  const next={...store,term:2,credential:'successor'};
  const successor=watchDirectoryRoom(client,{store:next,getSummary:()=>view});
  t.after(()=>successor.stop());
  await successor.refresh();
  assert.equal(calls.at(-1).args.p_room_id,'archive');
  assert.equal(calls.at(-1).args.p_term,2);
  await Promise.all([successor.close(),successor.close()]);
  assert.deepEqual(calls.at(-1),{operation:'close',headers:{apikey:'test-public','Content-Type':'application/json',Authorization:'Bearer member-token'},
    args:{p_room_id:'archive',p_credential:'successor',p_term:2}});
  assert.equal(calls.filter(c=>c.operation==='close').length,1);
});

test('private heartbeat accepts an anonymous elected controller and a retired lease stops retrying',async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:10000});
  const errors=[];
  const calls=transport(t,()=>new Response(JSON.stringify({code:'P0002',message:'이미 닫힌 방입니다.'}),{status:404}));
  const guestClient={...client,state:{user:null}};
  const listing=watchDirectoryRoom(guestClient,{store,getSummary:()=>null,onError:error=>errors.push(error.message)});
  t.after(()=>listing.stop());
  await listing.refresh();
  assert.equal(calls[0].args.p_summary,null);
  assert.equal(calls[0].headers.Authorization,undefined);
  assert.equal(errors[0],'이미 닫힌 방입니다.');
  t.mock.timers.tick(60000);
  await listing.refresh();
  assert.equal(calls.length,1);
});
