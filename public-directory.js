import {openPeer} from './network.js';

export const PUBLIC_ROOM_LIMIT = 8;
const PROBE_TIMEOUT = 8000;

// Every browser on this deployment derives the same eight signaling IDs.
// Different sites and local previews have separate directories.
const site = new URL('.', import.meta.url).href;
let siteHash = 2166136261;
for (const char of site) siteHash = Math.imul(siteHash ^ char.charCodeAt(0), 16777619) >>> 0;
const channel = 'mighty-public-v1-' + siteHash.toString(36);
const slots = Array.from({length:PUBLIC_ROOM_LIMIT}, (_, i) => channel + '-slot-' + i);
const interrupted = () => new Error('공개 테이블 목록에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
const cancelled = () => new Error('공개 테이블 연결을 취소했습니다.');
const count = value => Number.isSafeInteger(value) && value >= 0;

// Only these fields cross the directory connection, even if the caller passes
// a whole session snapshot. A scan never opens a game or spectator connection.
function publicSummary(room) {
  if (!room || typeof room.code !== 'string' || !/^[A-Z0-9]{6}$/.test(room.code) || typeof room.hostName !== 'string' ||
      !room.hostName.trim() || room.hostName.length > 16 ||
      !['waiting','playing','finished'].includes(room.phase) ||
      !count(room.humanCount) || room.humanCount > 5 || !count(room.spectatorCount) ||
      !count(room.reservationCount) || !count(room.roundNumber) ||
      ![null,10,20].includes(room.roundLimit)) return null;
  const {code,hostName,phase,humanCount,spectatorCount,reservationCount,roundNumber,roundLimit} = room;
  return {code,hostName,phase,humanCount,spectatorCount,reservationCount,roundNumber,roundLimit};
}

function answerProbe(link, getSummary) {
  if (link.label !== channel) { link.close(); return; }
  const timer = setTimeout(() => link.close(), PROBE_TIMEOUT);
  link.on('close', () => clearTimeout(timer));
  link.on('error', () => { clearTimeout(timer); link.close(); });
  link.on('open', () => {
    try {
      link.send({kind:'summary', room:publicSummary(getSummary())});
    } catch {
      link.close();
    }
  });
}

export async function publishPublicRoom({getSummary, signal, onError}) {
  if (typeof getSummary !== 'function') throw new TypeError('공개 테이블 정보가 필요합니다.');
  const lifetime = new AbortController();
  let first = crypto.getRandomValues(new Uint8Array(1))[0] % slots.length;
  let current, retry, warned = false;
  function close() {
    signal?.removeEventListener('abort', close);
    lifetime.abort();
    clearTimeout(retry);
    const releasing = current;
    current = null;
    releasing?.destroy();
  }
  async function claim() {
    for (let offset = 0; offset < slots.length; offset++) {
      const index = (first + offset) % slots.length;
      let peer;
      try { peer = await openPeer(slots[index], lifetime.signal); }
      catch (error) {
        if (error.type === 'unavailable-id') continue;
        throw error;
      }
      if (lifetime.signal.aborted) { peer.destroy(); throw cancelled(); }
      current = peer;
      first = index;
      warned = false;
      // Reacquire the signaling ID after the socket drops. Never leave two
      // peers answering for this host, including after a replacement wins it.
      function lost() {
        if (current !== peer) return;
        current = null;
        peer.destroy();
        retry = setTimeout(restore, 2000);
      }
      peer.on('connection', link => answerProbe(link, getSummary));
      peer.on('disconnected', lost);
      peer.on('close', lost);
      peer.on('error', error => {
        if (error.type !== 'peer-unavailable' && error.type !== 'webrtc') lost();
      });
      return;
    }
    throw new Error('공개 테이블 ' + PUBLIC_ROOM_LIMIT + '개가 모두 열려 있습니다. 빈 테이블이 생기면 다시 시도해 주세요.');
  }
  async function restore() {
    if (lifetime.signal.aborted) return;
    try { await claim(); }
    catch {
      if (lifetime.signal.aborted) return;
      retry = setTimeout(restore, 15000);
      if (!warned) {
        warned = true;
        onError?.(new Error('공개 목록에 테이블을 다시 등록하는 중입니다. 현재 게임은 계속할 수 있습니다.'));
      }
    }
  }
  if (signal?.aborted) throw cancelled();
  signal?.addEventListener('abort', close, {once:true});
  try { await claim(); }
  catch (error) { close(); throw error; }
  return {close};
}

export async function listPublicRooms({signal} = {}) {
  const reader = await openPeer(channel + '-reader-' + crypto.randomUUID(), signal);
  try {
    if (signal?.aborted) throw cancelled();
    return await new Promise((resolve, reject) => {
      const pending = new Set(slots), rooms = new Map();
      let answered = false, settled = false;
      function end(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error || !answered) reject(error || interrupted());
        else resolve(Array.from(rooms.values()).sort((a,b) => a.code.localeCompare(b.code)));
      }
      const abort = () => end(cancelled());
      function complete(id, confirmed) {
        if (!pending.delete(id)) return;
        answered ||= confirmed;
        if (!pending.size) end();
      }
      const timer = setTimeout(() => end(), PROBE_TIMEOUT);
      signal?.addEventListener('abort', abort, {once:true});
      reader.on('close', () => end(interrupted()));
      reader.on('disconnected', () => end(interrupted()));
      reader.on('connection', link => link.close());
      reader.on('error', error => {
        // PeerJS reports an absent target on the shared Peer, not on its link.
        // Its 1.5.5 error message terminates with the exact remote signaling ID.
        if (error.type === 'peer-unavailable') {
          const id = error.message?.split(' ').at(-1);
          complete(id, true);
        } else if (error.type !== 'webrtc') end(interrupted());
      });
      for (const id of slots) {
        const link = reader.connect(id, {label:channel, reliable:true, serialization:'json'});
        if (!link) { complete(id, false); continue; }
        link.on('data', packet => {
          if (settled || !pending.has(id)) return;
          const room = packet?.kind === 'summary' && publicSummary(packet.room);
          if (room) rooms.set(room.code, room);
          complete(id, true);
          link.close();
        });
        link.on('close', () => complete(id, false));
        link.on('error', () => complete(id, false));
      }
    });
  } finally {
    reader.destroy();
  }
}
