import assert from 'node:assert/strict';
import test from 'node:test';
import {ChatLog, chatText} from '../chat.js';
import {createRoomChatRelay} from '../room-chat-relay.js';

const message = id => ({id, seat:1, name:'친구', time:1700000000000, text:' 안녕하세요! '});

test('room chat accepts ordered messages, retains the last 60, and ignores duplicates', () => {
  const log = new ChatLog();
  for (let id = 1; id <= 65; id++) assert.equal(log.accept(message(id)), true);
  assert.equal(log.messages.length, 60);
  assert.equal(log.messages[0].id, 6);
  assert.equal(log.lastId, 65);
  assert.equal(log.accept(message(65)), false);
  assert.equal(log.accept(message(10)), false);
  assert.equal(log.messages.length, 60);
});

test('chat keeps only public message fields and validates text at the sender and receiver', () => {
  const log = new ChatLog();
  assert.equal(chatText('  안녕!  '), '안녕!');
  for (const text of ['', '  ', 'a'.repeat(281), 123]) {
    assert.equal(chatText(text), '');
    assert.equal(log.accept({...message(1), text}), false);
  }
  assert.equal(log.accept({...message(1), seat:5}), false);
  assert.equal(log.accept({...message(1), time:NaN}), false);
  assert.equal(log.accept({...message(1), unrelated:'extra data'}), true);
  assert.deepEqual(log.messages, [{...message(1), text:'안녕하세요!'}]);
});

test('device history can arrive after live chat without dropping or duplicating new messages', () => {
  const log = new ChatLog();
  log.accept(message(70));
  log.restore([message(64),message(65),message(70)],false);
  log.restore(Array.from({length:62}, (_,i) => message(i+1)),true);
  assert.deepEqual(log.messages.map(m => m.id),[...Array.from({length:62},(_,i) => i+1),64,65,70]);
  log.clear();
  assert.equal(log.lastId,0);
});

function localRoom() {
  const sent=[], seen=[], opened=[];
  const peerIds=new Set(['G1','G2']);
  const chat={enterRoom:(...args)=>opened.push(args),notice:()=>{},receive:(...args)=>seen.push(args)};
  const relay=createRoomChatRelay({chat,accountId:()=>'account',peers:()=>peerIds,
    sendPeer:(id,packet)=>{sent.push([id,packet]);return true;},sendHost:packet=>{sent.push(['host',packet]);return true;}});
  const rows=new Map();
  const store={id:crypto.randomUUID(),open:async()=>{},append:async entry=>{
    const existing=rows.get(entry.requestId);
    if (existing) return {...existing,replayed:true};
    const row={id:rows.size+1,time:1700000000000,name:entry.name,seat:entry.seat,text:entry.text};
    rows.set(entry.requestId,row);return {...row,replayed:false};
  }};
  return {sent,seen,opened,peerIds,relay,store,rows};
}

test('new arrivals receive only the room identifier, and earlier host versions cannot restore a backlog', async () => {
  const h=localRoom(),guest=localRoom();
  await h.relay.startHost(h.store);
  await h.relay.persist(0,'방장','먼저 쓴 글',null,'owner',crypto.randomUUID());
  h.sent.length=0; h.peerIds.add('G3'); h.relay.greet('G3');
  assert.deepEqual(h.sent,[['G3',{type:'chat-room',roomId:h.store.id}]]);
  guest.relay.receive(h.sent[0][1]);
  assert.deepEqual(guest.opened,[[h.store.id,'account']]);
  guest.relay.receive({type:'chat-history',messages:[message(1)]});
  assert.deepEqual(guest.seen,[]);
  assert.equal(guest.relay.receive({type:'game'}),false);
  await guest.relay.startHost(h.store);
  assert.deepEqual(guest.seen,[],'taking over a table cannot reveal missed messages');
});

test('a persisted resend acknowledges only its sender and cannot publish an old message to fresh peers',async()=>{
  const h=localRoom(),guest=localRoom();
  await h.relay.startHost(h.store);guest.relay.receive({type:'chat-room',roomId:h.store.id});
  const key=crypto.randomUUID(), sending=guest.relay.sendGuest('안녕',key);
  await h.relay.persist(1,'민수','안녕','G1','member-1',key);
  const own=h.sent.find(([id])=>id==='G1')[1],other=h.sent.find(([id])=>id==='G2')[1];
  assert.equal(other.requestId,undefined);assert.equal(own.requestId,key);
  guest.relay.receive(own);assert.equal(await sending,true);
  h.peerIds.add('G3');h.sent.length=0;
  await h.relay.persist(1,'민수','안녕','G1','member-1',key);
  assert.deepEqual(h.sent,[['G1',own]]);assert.equal(h.seen.length,1);
  await h.relay.persist(2,'서연','같은 요청값','G2','member-2',key);
  assert.equal(h.rows.size,2);
});
