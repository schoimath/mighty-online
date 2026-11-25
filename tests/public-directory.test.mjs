import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setImmediate as turn} from 'node:timers/promises';
import {listPublicRooms, publishPublicRoom, PUBLIC_ROOM_LIMIT} from '../public-directory.js';

// PeerServer arbitrates a signaling ID. Absent destinations report errors
// on the dialing peer, while each established DataConnection is independent.
function signaling(t) {
  const peers = new Map(), silent = new Set();
  class Link extends EventEmitter {
    send(value) { queueMicrotask(() => this.other.emit('data', structuredClone(value))); }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
      this.other?.close();
    }
  }
  class Peer extends EventEmitter {
    constructor(id) {
      super();
      this.id = id;
      this.links = [];
      queueMicrotask(() => {
        if (this.destroyed) return;
        if (peers.has(id)) {
          this.emit('error', {type:'unavailable-id'});
          return;
        }
        peers.set(id, this);
        this.emit('open', id);
      });
    }
    connect(id, {label}) {
      const link = new Link();
      this.links.push(link);
      queueMicrotask(() => {
        if (this.destroyed || silent.has(id)) return;
        const target = peers.get(id);
        if (!target) {
          this.emit('error', {type:'peer-unavailable', message:'Could not connect to peer ' + id});
          return;
        }
        const incoming = new Link();
        target.links.push(incoming);
        incoming.label = label;
        link.other = incoming;
        incoming.other = link;
        target.emit('connection', incoming);
        incoming.emit('open');
        link.emit('open');
      });
      return link;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (peers.get(this.id) === this) peers.delete(this.id);
      for (const link of this.links) link.close();
      this.emit('close');
    }
  }
  const prior = globalThis.peerjs;
  globalThis.peerjs = {Peer};
  t.after(() => { globalThis.peerjs = prior; });
  const active = new AbortController();
  t.after(() => active.abort());
  const publish = getSummary => publishPublicRoom({getSummary, signal:active.signal});
  return {peers, silent, publish};
}

const summary = code => ({
  code, hostName:'마이티', phase:'waiting', humanCount:1, spectatorCount:0,
  reservationCount:0, roundNumber:0, roundLimit:10
});

test('concurrent public hosts share eight slots, preserve random room codes and release on close', async t => {
  const {peers, publish} = signaling(t);
  assert.deepEqual(await listPublicRooms(), []);
  const claims = await Promise.allSettled(Array.from({length:PUBLIC_ROOM_LIMIT + 2}, (_, i) =>
    publish(() => summary('MIGHT' + i))));
  const accepted = claims.filter(p => p.status === 'fulfilled');
  assert.equal(accepted.length, PUBLIC_ROOM_LIMIT);
  assert.equal(peers.size, PUBLIC_ROOM_LIMIT);
  assert.equal(claims.filter(p => p.status === 'rejected' && p.reason.message.includes('8개')).length, 2);
  const rows = await listPublicRooms();
  assert.equal(new Set(rows.map(r => r.code)).size, PUBLIC_ROOM_LIMIT);
  accepted[0].value.close();
  await publish(() => summary('ABC234'));
  assert.ok((await listPublicRooms()).some(r => r.code === 'ABC234'));
});

test('lookups read live public fields, skip malformed advertisements and release the reader', async t => {
  const {peers, publish} = signaling(t);
  const room = {...summary('ABC234'), hand:['JK'], members:['private id']};
  const lease = await publish(() => room);
  await publish(() => ({...room, code:['ABC234']}));
  assert.deepEqual(await listPublicRooms(), [summary('ABC234')]);
  room.phase = 'playing';
  room.spectatorCount++;
  assert.deepEqual(await listPublicRooms(), [{...summary('ABC234'), phase:'playing', spectatorCount:1}]);
  assert.equal(peers.size, 2);
  lease.close();
  assert.deepEqual(await listPublicRooms(), []);
});

test('a stalled probe and absent peers cannot cancel a responding room, and a scan can be aborted', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {peers, silent, publish} = signaling(t);
  await publish(() => summary('ABC234'));
  const [occupied] = peers.keys();
  const other = occupied.replace(/\d+$/, n => String((Number(n) + 1) % PUBLIC_ROOM_LIMIT));
  silent.add(other);
  const scan = listPublicRooms();
  await turn();
  t.mock.timers.tick(8001);
  assert.deepEqual(await scan, [summary('ABC234')]);
  const controller = new AbortController();
  const second = listPublicRooms({signal:controller.signal});
  await turn();
  controller.abort();
  await assert.rejects(second, /취소/);
  assert.equal(peers.size, 1);
});

test('a disconnected slot is reacquired without displacing its new owner or advertising twice', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {peers, publish} = signaling(t);
  const lease = await publish(() => summary('ABC234'));
  const [first] = peers.values();
  first.emit('disconnected');
  assert.equal(peers.size, 0);
  const other = new globalThis.peerjs.Peer(first.id);
  await turn();
  t.mock.timers.tick(2000);
  await turn();
  assert.equal(peers.size, 2);
  assert.equal(peers.get(first.id), other);
  other.destroy();
  assert.deepEqual(await listPublicRooms(), [summary('ABC234')]);
  lease.close();
  t.mock.timers.tick(30000);
  assert.equal(peers.size, 0);
});
