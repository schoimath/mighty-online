import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {setImmediate as turn} from 'node:timers/promises';
import {hostRoom,joinRoom} from '../network.js';

function transport(t, failures=[]) {
  const previous=globalThis.peerjs, peers=[];
  globalThis.peerjs={Peer:class extends EventEmitter {
    constructor(id) {
      super(); this.id=id; peers.push(this);
      const failure=failures.shift();
      if (failure !== 'pending') queueMicrotask(()=>failure ? this.emit('error',{type:failure}) : this.emit('open'));
    }
    connect(address) {
      this.address=address;
      const link=this.link=new EventEmitter();
      link.open=true;
      link.close=()=>{link.open=false;};
      link.sent=[];
      link.send=packet=>link.sent.push(packet);
      return link;
    }
    destroy() {this.destroyed=true; this.link?.close(); this.emit('close');}
  }};
  t.after(()=>{if(previous===undefined) delete globalThis.peerjs; else globalThis.peerjs=previous;});
  return peers;
}
const state=seat=>({type:'state',view:{seat,players:[{name:'방장'},null,null,null,null],game:null}});
const welcome={kind:'welcome'};
const game=message=>({kind:'game',message});

test('welcome without a first roster times out on the join form, releases the peer and permits another admission',async t=>{
  const peers=transport(t), accepted=[], closed=[];
  t.mock.timers.enable({apis:['setTimeout']});
  const options={onMessage:m=>accepted.push(m),onClose:(...args)=>closed.push(args)};
  const first=joinRoom('PUB001','첫 방문',options);
  await turn();
  peers[0].link.emit('data',welcome);
  peers[0].link.emit('data',game({type:'audience'}));
  t.mock.timers.tick(20000);
  await assert.rejects(first,{message:/방 정보를 받지 못했습니다/,retryable:true});
  assert.equal(peers[0].destroyed,true);
  assert.deepEqual(accepted,[]);
  assert.deepEqual(closed,[]);
  const retry=joinRoom('PUB001','첫 방문',options);
  await turn();
  const roster=state(1);
  peers[1].link.emit('data',welcome);
  peers[1].link.emit('data',game(roster));
  const room=await retry;
  assert.deepEqual(accepted,[roster]); assert.equal(room.code,'PUB001');
  room.close();
  assert.deepEqual(closed,[]);
});

test('pre-roster history and later room events are delivered once, in order, for an admitted spectator',async t=>{
  const peers=transport(t), messages=[], closed=[];
  const pending=joinRoom('PUB004','관전',{intent:'watch',onMessage:m=>messages.push(m),onClose:(...args)=>closed.push(args)});
  await turn();
  const {link}=peers[0], initial=state(-1), history={type:'chat-history',messages:[]}, follow={type:'state',view:{...initial.view,revision:2}};
  link.emit('data',game({type:'audience'})); // before admission acknowledgement
  link.emit('data',welcome);
  link.emit('data',game(history));
  assert.deepEqual(messages,[]);
  link.emit('data',game(initial));
  const joined=await pending;
  link.emit('data',welcome);
  link.emit('data',game(follow));
  assert.deepEqual(messages,[history,initial,follow]);
  assert.equal(joined.send({type:'reservation'}),true);
  assert.deepEqual(link.sent,[game({type:'reservation'})]);
  link.emit('data',{kind:'bye',reason:'방에서 퇴장했습니다.'});
  assert.deepEqual(closed,[['방에서 퇴장했습니다.',true]]);
});

test('cancel, explicit refusal, invalid state and lost transport remain separate join failures before a usable roster',async t=>{
  const peers=transport(t), disconnected=[];
  for(const reason of ['cancel','bye','invalid','link','peer-unavailable']) {
    const controller=new AbortController();
    const pending=joinRoom('PUB002','참가',{signal:controller.signal,onClose:(...args)=>disconnected.push(args)});
    await turn();
    const peer=peers.at(-1);
    peer.link.emit('data',welcome);
    if(reason==='cancel') controller.abort();
    if(reason==='bye') peer.link.emit('data',{kind:'bye',reason:'이미 이 계정이 테이블에 있습니다.'});
    if(reason==='invalid') peer.link.emit('data',game({type:'state',view:{}}));
    if(reason==='link') peer.link.emit('close');
    if(reason==='peer-unavailable') peer.emit('error',{type:reason});
    const messages={cancel:/취소/,bye:/이미 이 계정/,invalid:/참가자 정보/,link:/종료/,'peer-unavailable':/방을 찾을 수 없습니다/};
    await assert.rejects(pending,error=>messages[reason].test(error.message) &&
      Boolean(error.retryable)===['link','peer-unavailable'].includes(reason));
    assert.equal(peer.destroyed,true);
  }
  assert.deepEqual(disconnected,[]);
});

test('a newly reserved public slot briefly retries its exact signaling ID and disposes each previous connection',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const peers=transport(t,['unavailable-id','unavailable-id']);
  const opening=hostRoom({reclaimCode:'PUB001',waitForCode:true});
  await turn();
  assert.equal(peers.length,1); assert.equal(peers[0].destroyed,true);
  t.mock.timers.tick(350);
  await turn();
  assert.equal(peers.length,2); assert.equal(peers[1].destroyed,true);
  t.mock.timers.tick(700);
  const room=await opening;
  assert.equal(room.code,'PUB001');
  assert.deepEqual(peers.map(p=>p.id),Array(3).fill('mighty-online-v1-PUB001'));
  room.close();
  assert.ok(peers.every(p=>p.destroyed));
});

test('a stale fixed public ID cannot block a new table or redirect its scoped invites',async t=>{
  const peers=transport(t,[null,'unavailable-id']);
  const signalRoute='abc1'.repeat(8);
  const errors=[];
  const host=await hostRoom({reclaimCode:'PUB001',signalRoute,waitForCode:true,onError:e=>errors.push(e)});
  await turn();
  const scoped='mighty-online-v1-PUB001-'+signalRoute;
  assert.deepEqual(peers.map(p=>p.id),[scoped,'mighty-online-v1-PUB001']);
  assert.equal(host.code,'PUB001');
  assert.ok(peers[1].destroyed);
  const joining=joinRoom('PUB001','참가자',{signalRoute:signalRoute.toUpperCase()});
  await turn();
  assert.equal(peers[2].address,scoped);
  peers[2].link.emit('data',welcome); peers[2].link.emit('data',game(state(-1)));
  const guest=await joining;
  assert.equal(guest.code,'PUB001');
  guest.close(); host.close();
  assert.ok(peers.every(peer=>peer.destroyed));
  assert.deepEqual(errors,[]);
});

test('public legacy and scoped addresses deliver the same roster and allocate separate connection IDs',async t=>{
  const peers=transport(t);
  const arrivals=[];
  const host=await hostRoom({reclaimCode:'PUB003',signalRoute:'1'.repeat(32),onJoin(id,name){
    arrivals.push({id,name});
    host.send(id,state(-1));
  }});
  await turn();
  const [primary,alias]=peers;
  for (const [index,peer] of [primary,alias].entries()) {
    const link=peer.connect();
    Object.assign(link,{label:'mighty-online-v1',metadata:{name:'참가자'+index}});
    peer.emit('connection',link); link.emit('open');
    assert.deepEqual(link.sent,[welcome,game(state(-1))]);
  }
  assert.deepEqual(arrivals,[{id:'1',name:'참가자0'},{id:'2',name:'참가자1'}]);
  assert.equal(host.send('2',{type:'chat'}),true);
  assert.deepEqual(alias.link.sent.at(-1),game({type:'chat'}));
  host.close();host.close();
  assert.ok(peers.every(peer=>peer.destroyed && !peer.link.open));
});

test('pending legacy aliases are retired on close, invalid routes fail before connecting and private rooms keep their original addresses',async t=>{
  const peers=transport(t,[null,'pending']);
  for (const signalRoute of ['',123,'../PUB001','a'.repeat(31)]) {
    await assert.rejects(hostRoom({reclaimCode:'PUB001',signalRoute}),/연결 주소/);
    await assert.rejects(joinRoom('PUB001','참가자',{signalRoute}),/연결 주소/);
  }
  assert.equal(peers.length,0);
  const host=await hostRoom({reclaimCode:'PUB002',signalRoute:'b'.repeat(32)});
  host.close(); await turn();
  assert.ok(peers.every(peer=>peer.destroyed));
  const privateRoom=await hostRoom({reclaimCode:'ROOM02'});
  assert.equal(peers.length,3);assert.equal(peers[2].id,'mighty-online-v1-ROOM02');
  const joining=joinRoom('ROOM02','초대 손님');
  await turn();
  assert.equal(peers[3].address,peers[2].id);
  peers[3].link.emit('data',welcome); peers[3].link.emit('data',game(state(1)));
  const invited=await joining;
  assert.equal(invited.code,'ROOM02');
  invited.close();privateRoom.close();
});

test('fixed-code retry is cancelable, bounded, and only used for occupied IDs on an explicitly new public room',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const failures=[], peers=transport(t,failures);
  failures.push('unavailable-id');
  await assert.rejects(hostRoom({reclaimCode:'PUB002'}),{type:'unavailable-id'});
  failures.push('server-error');
  await assert.rejects(hostRoom({reclaimCode:'PUB002',waitForCode:true}),{type:'server-error'});
  failures.push('unavailable-id');
  const controller=new AbortController();
  const interrupted=hostRoom({reclaimCode:'PUB002',waitForCode:true,signal:controller.signal});
  await turn();
  controller.abort();
  await assert.rejects(interrupted,/취소/);
  t.mock.timers.tick(5000);
  assert.equal(peers.length,3);
  failures.push('unavailable-id','unavailable-id','unavailable-id');
  const exhausted=hostRoom({reclaimCode:'PUB002',waitForCode:true});
  await turn(); t.mock.timers.tick(350); await turn(); t.mock.timers.tick(700);
  await assert.rejects(exhausted,{type:'unavailable-id'});
  assert.equal(peers.length,6);
  assert.ok(peers.every(p=>p.destroyed));
});
