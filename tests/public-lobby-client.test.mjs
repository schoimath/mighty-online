import assert from 'node:assert/strict';
import test from 'node:test';
import {mayConfirmPublicDeal,openPublicLobby,requestPublicLobby} from '../public-lobby-client.js';

const roomId = 'f9b289fd-45b6-4cc6-989e-820ecc6e2864';
const credential = '83'.repeat(32);
const response = (cursor,messages = []) => ({roomId,cursor,messages,view:{seat:-1}});

test('entry skips archive history and queued operations use successive live cursors', async () => {
  const seen = [], calls = [];
  const replies = [response(4,[{id:3}]),response(5,[{id:5}]),response(6,[{id:6}])];
  const lobby = openPublicLobby({slot:2,credential,delay:() => 60000,
    request:async payload => { calls.push(payload); return replies.shift(); },
    onState:data => seen.push(...data.messages.map(message => message.id)),onError:assert.fail});
  const chatId = crypto.randomUUID();
  try {
    await lobby.send('join',{name:'하트'});
    await Promise.all([lobby.send('chat',{text:'안녕하세요',requestId:chatId}),lobby.wake()]);
    assert.deepEqual(seen,[5,6]);
    assert.deepEqual(calls.map(c => [c.op,c.roomId,c.after]),[
      ['join',undefined,0],['chat',roomId,4],['poll',roomId,5]]);
    assert.equal(calls[1].requestId,chatId);
  } finally { lobby.close(); }
});

test('closing a pending connection never paints its late response',async () => {
  const deferred = Promise.withResolvers(), requested = Promise.withResolvers();
  const seen = [];
  const lobby = openPublicLobby({slot:1,credential,delay:() => 60000,
    request:async () => { requested.resolve(); return deferred.promise; },
    onState:data => seen.push(data),onError:assert.fail});
  const entry = lobby.send('join',{name:'방문자'});
  await requested.promise;
  lobby.close();
  deferred.resolve(response(0));
  await assert.rejects(entry,/나왔습니다/);
  assert.equal(seen.length,0);
});

test('a reloaded tab verifies its saved membership and starts a fresh live chat cursor',async () => {
  const calls = [], seen = [];
  const lobby = openPublicLobby({slot:2,credential,initialRoomId:roomId,delay:() => 60000,
    request:async input => { calls.push(input); return response(7,[{id:6}]); },
    onState:data => seen.push(data.messages),onError:assert.fail});
  try {
    await lobby.send('poll');
    await lobby.send('poll');
    assert.deepEqual(calls.map(c => [c.op,c.roomId,c.after]),[['poll',roomId,undefined],['poll',roomId,7]]);
    assert.deepEqual(seen[0],[]);
  } finally { lobby.close(); }
});

test('consent covers the current seat, reserved seat or actual spectator host, and the selected rules',() => {
  const botModels = Array(5).fill('model');
  const base = {seat:3,spectator:false,isHost:false,botModels,rules:{minBid:14},pace:'normal',autoPlay:true};
  const offer = {room:'PUB002',host:'host',seats:[null,null,null,'guest',null],rules:{minBid:14},models:botModels};
  const eligible = (changes,account,spec=offer) => mayConfirmPublicDeal({...base,...changes},spec,'PUB002',account);
  assert.equal(eligible({},'guest'),true);
  assert.equal(eligible({seat:-1,spectator:true,reservation:{seat:3}},'guest'),true);
  assert.equal(eligible({seat:-1,spectator:true,isHost:true},'host'),true);
  assert.equal(eligible({seat:-1,spectator:true},'host'),false);
  const sameAccount = {...offer,host:'guest'};
  assert.equal(eligible({},'guest',sameAccount),true);
  assert.equal(eligible({seat:-1,spectator:true,isHost:true},'guest',sameAccount),false);
  assert.equal(eligible({seat:1},'guest'),false);
  assert.equal(eligible({departing:true},'guest'),false);
  assert.equal(eligible({pace:'fast'},'guest'),false);
  assert.equal(eligible({},'guest',{...offer,autoPlay:false}),true);
  assert.equal(eligible({},'guest',{...offer,autoPlay:'false'}),false);
  assert.equal(eligible({},'guest',{...offer,room:'PUB004'}),false);
});

test('an anonymous spectator can enter directly through the same HTTPS service as the host',async t => {
  const headers = [];
  t.mock.method(globalThis,'fetch',async (url,options) => {
    assert.equal(url,'https://game.example/functions/v1/public-lobby');
    headers.push(options.headers);
    return Response.json(response(0));
  });
  const client = {url:'https://game.example/',publishableKey:'public',accessToken:async () => null};
  await requestPublicLobby(client,{op:'join',slot:2,name:'관전자',credential});
  await requestPublicLobby({...client,accessToken:async () => 'player-token'},{op:'seat',slot:2,credential});
  assert.equal(headers[0].Authorization,undefined);
  assert.equal(headers[1].Authorization,'Bearer player-token');
  assert.equal(headers[0].apikey,'public');
});
