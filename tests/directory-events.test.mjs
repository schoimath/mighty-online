import assert from 'node:assert/strict';
import test from 'node:test';
import {subscribeDirectoryEvents} from '../directory-events.js';

const topic = 'realtime:mighty-public-directory';
const client = {url:'https://example.invalid',publishableKey:'test-public'};
const change = {topic,event:'broadcast',payload:{type:'broadcast',event:'changed',payload:{}}};

function subscribe(t) {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const sockets = [], status = [], changes = [];
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); }
    send(packet) { this.sent.push(JSON.parse(packet)); }
    close() { this.closed = true; }
    receive(packet) { this.onmessage?.({data:JSON.stringify(packet)}); }
    join() {
      this.onopen();
      this.receive({topic,event:'phx_reply',ref:this.sent[0].ref,payload:{status:'ok'}});
    }
  };
  const stop = subscribeDirectoryEvents(client,{onStatus:ready=>status.push(ready),onChange:(...args)=>changes.push(args)});
  t.after(() => { stop(); globalThis.WebSocket = original; });
  return {sockets,status,changes,stop};
}

test('a public lobby subscribes without account credentials and receives only directory wake-ups', t => {
  const {sockets:[socket],status,changes} = subscribe(t);
  assert.equal(socket.url.protocol, 'wss:');
  assert.equal(socket.url.pathname, '/realtime/v1/websocket');
  assert.deepEqual(Object.fromEntries(socket.url.searchParams),{apikey:'test-public',vsn:'1.0.0'});
  socket.receive(change);
  socket.join();
  const [join] = socket.sent;
  assert.equal(join.topic,topic);
  assert.equal(join.event,'phx_join');
  assert.equal(join.join_ref,join.ref);
  assert.equal(join.payload.config.private,false);
  assert.deepEqual(status,[true]);
  socket.onmessage({data:'invalid JSON'});
  socket.receive({...change,topic:'realtime:unrelated'});
  socket.receive({...change,payload:{event:'other'}});
  socket.receive(change);
  assert.deepEqual(changes,[[]]);
});

test('an idle lobby acknowledges heartbeats, drops a silent connection and catches up on rejoin', t => {
  const {sockets,status,changes} = subscribe(t);
  const first = sockets[0];
  first.join();
  t.mock.timers.tick(25000);
  const ping = first.sent.at(-1);
  assert.equal(ping.event,'heartbeat');
  first.receive({topic:'phoenix',event:'phx_reply',ref:ping.ref,payload:{status:'ok'}});
  t.mock.timers.tick(25000);
  assert.deepEqual(status,[true]);
  t.mock.timers.tick(25000);
  assert.deepEqual(status,[true,false]);
  assert.equal(first.closed,true);
  t.mock.timers.tick(2500);
  assert.equal(sockets.length,2);
  sockets[1].join();
  first.receive(change);
  sockets[1].receive(change);
  assert.deepEqual(changes,[[]]);
  assert.deepEqual(status,[true,false,true]);
});

test('missing join acknowledgements use fallback and leaving the lobby cancels reconnects', t => {
  const {sockets,status,changes,stop} = subscribe(t);
  sockets[0].onopen();
  t.mock.timers.tick(10000);
  assert.deepEqual(status,[false]);
  t.mock.timers.tick(2500);
  sockets[1].join();
  sockets[1].receive({topic,event:'phx_error',payload:{}});
  stop();
  t.mock.timers.tick(60000);
  sockets[1].receive(change);
  assert.deepEqual(changes,[]);
  assert.deepEqual(status,[false,true,false]);
  assert.equal(sockets.length,2);
});
