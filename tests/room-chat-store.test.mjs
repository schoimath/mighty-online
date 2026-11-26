import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRoomChatStore, newChatCredential} from '../room-chat-store.js';

test('room credentials stay per-controller, anonymous successors use their own secret and stale terms recover', async t => {
  const calls=[], client={url:'https://game.example.invalid',publishableKey:'public',state:{user:{id:'founder'}},
    ready:Promise.resolve(), accessToken:async ()=>'test-access-token'};
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    const operation=new URL(url).pathname.split('mighty_room_chat_')[1];
    calls.push({operation,args:JSON.parse(options.body),headers:options.headers});
    return Response.json({open:1,successors:null,transfer:2,claim:4,append:{id:1,time:1000,seat:-1,name:'관전자',text:'안녕하세요',replayed:false}}[operation]);
  });
  const host=createRoomChatStore(client,'ABC123'), spare=newChatCredential();
  assert.match(host.credential,/^[0-9a-f]{64}$/);
  assert.notEqual(host.credential,spare);
  assert.deepEqual(await Promise.all([host.open(),host.open()]),[1,1]);
  assert.equal(calls.filter(c=>c.operation==='open').length,1);
  await host.setSuccessors([{accountId:null,credential:spare}]);
  await host.transfer(spare);
  const hashed=createHash('sha256').update(spare).digest('hex');
  assert.deepEqual(calls[1].args.p_successors,[{accountId:null,digest:hashed}]);
  assert.equal(calls[2].args.p_digest,hashed);
  assert.ok(!JSON.stringify(calls[1].args).includes(spare));
  const guest=createRoomChatStore({...client,state:{user:null}},'ABC123',host.id,spare);
  assert.equal(await guest.claim(1),true);
  assert.equal(guest.term,4);
  const receipt=await guest.append({requestId:crypto.randomUUID(),seat:-1,name:'관전자',text:'안녕하세요'});
  assert.equal(receipt.text,'안녕하세요');
  assert.equal(calls.at(-1).args.p_term,4);
  assert.equal(calls.at(-1).args.p_credential,spare);
  assert.equal(calls.at(-1).headers.Authorization,undefined);
  assert.equal(guest.history,undefined);
});

test('a failed archive save leaves the next send usable and can be retried with the same request', async t=>{
  const request=crypto.randomUUID(), requests=[];
  const client={url:'https://game.example.invalid',publishableKey:'public',state:{user:{id:'owner'}},ready:Promise.resolve(),accessToken:async ()=>'test'};
  t.mock.method(globalThis,'fetch',async(url,opts)=>{
    if(url.endsWith('_open'))return Response.json(1);
    requests.push(JSON.parse(opts.body).p_request);
    if(requests.length===1) return Response.json({},{status:503});
    return Response.json({id:1,replayed:true});
  });
  const store=createRoomChatStore(client,'ABC123'),message={requestId:request,seat:0,name:'방장',text:'메시지'};
  await assert.rejects(store.append(message),{status:503});
  assert.deepEqual(await store.append(message),{id:1,replayed:true});
  assert.deepEqual(requests,[request,request]);
});
