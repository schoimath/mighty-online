const CHANNEL = 'mighty-online-v1';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CONNECT_TIMEOUT = 20000;

export function normalizeRoomCode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
}

function randomCode(length) {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)),
    byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

const cancelled = () => new Error('연결을 취소했습니다.');

function connectionError(error) {
  const messages = {
    'peer-unavailable': '방을 찾을 수 없습니다. 방 코드와 방장의 접속 상태를 확인해 주세요.',
    'unavailable-id': '같은 방 코드가 이미 사용 중입니다. 다시 방을 만들어 주세요.',
    'browser-incompatible': '이 브라우저는 실시간 연결을 지원하지 않습니다. 최신 브라우저에서 열어 주세요.',
    'webrtc': '방장과 연결할 수 없습니다. 다른 네트워크에서 다시 시도해 주세요.'
  };
  const message = messages[error?.type] ?? '연결 서버에 접속할 수 없습니다. 네트워크를 확인하고 다시 시도해 주세요.';
  const result = new Error(message, {cause: error});
  result.type = error?.type;
  return result;
}

export async function openPeer(id, signal) {
  if (signal?.aborted) throw cancelled();
  if (!globalThis.peerjs?.Peer) {
    await import('./vendor/peerjs-1.5.5/peerjs.min.js');
  }
  if (signal?.aborted) throw cancelled();
  const peer = new globalThis.peerjs.Peer(id, {secure: true});
  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      peer.off('error', failed);
      peer.off('open', opened);
    }
    function fail(error) {
      cleanup();
      peer.destroy();
      reject(error);
    }
    function abort() { fail(cancelled()); }
    function failed(error) { fail(connectionError(error)); }
    function opened() {
      cleanup();
      resolve(peer);
    }
    const timer = setTimeout(() => fail(connectionError()), CONNECT_TIMEOUT);
    signal?.addEventListener('abort', abort, {once: true});
    peer.on('error', failed);
    peer.on('open', opened);
  });
}

// A temporarily interrupted ICE link may recover without losing its seat.
function watchLink(link, lost) {
  let timer;
  let done = false;
  function finish() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    lost();
    link.close();
  }
  link.on('close', finish);
  link.on('error', finish);
  link.on('iceStateChanged', state => {
    if (done) return;
    clearTimeout(timer);
    if (state === 'disconnected') timer = setTimeout(finish, 15000);
    if (state === 'failed' || state === 'closed') finish();
  });
}

function goodbye(link, reason) {
  if (!link.open) {
    link.close();
    return;
  }
  link.send({kind: 'bye', reason});
  link.close({flush: true});
  setTimeout(() => { if (link.open) link.close(); }, 1500);
}

export async function hostRoom({onJoin, onMessage, onLeave, onError, signal} = {}) {
  let code, peer;
  for (let attempt = 0; attempt < 4; attempt++) {
    code = randomCode(6);
    try {
      peer = await openPeer(CHANNEL + '-' + code, signal);
      break;
    } catch (error) {
      if (error.type !== 'unavailable-id' || attempt === 3) throw error;
    }
  }
  if (signal?.aborted) {
    peer.destroy();
    throw cancelled();
  }
  const guests = new Map();
  let roomClosed = false;
  let reconnectTimer;
  let nextId = 1;

  function send(id, message) {
    const guest = guests.get(id);
    if (!guest?.link.open || roomClosed) return false;
    if (guest.pending) guest.pending.push(message);
    else guest.link.send({kind: 'game', message});
    return true;
  }
  function drop(id, reason = '방에서 퇴장했습니다.') {
    const guest = guests.get(id);
    if (!guest) return;
    guests.delete(id);
    goodbye(guest.link, reason);
    if (!guest.pending && !roomClosed) onLeave?.(id);
  }
  function close() {
    if (roomClosed) return;
    roomClosed = true;
    clearTimeout(reconnectTimer);
    guests.clear();
    peer.destroy();
  }
  peer.on('connection', link => {
    const id = String(nextId++);
    const guest = {link, pending: []};
    const timer = setTimeout(() => link.close(), CONNECT_TIMEOUT);
    watchLink(link, () => {
      clearTimeout(timer);
      if (guests.delete(id) && !guest.pending && !roomClosed) onLeave?.(id);
    });
    link.on('open', () => {
      clearTimeout(timer);
      const name = link.metadata?.name;
      if (roomClosed || link.label !== CHANNEL || typeof name !== 'string' || !name.trim() || name.length > 32) {
        goodbye(link, '입장 정보를 확인하고 다시 시도해 주세요.');
        return;
      }
      guests.set(id, guest);
      let decision;
      try {
        decision = onJoin?.(id, name.trim(), link.metadata?.intent);
      } catch (error) {
        onError?.(error);
        decision = '방에 입장하지 못했습니다.';
      }
      if (typeof decision === 'string' || decision === false) {
        drop(id, decision || '지금은 입장할 수 없습니다.');
        return;
      }
      if (!guests.has(id)) return;
      link.send({kind: 'welcome'});
      const pending = guest.pending;
      guest.pending = null;
      for (const message of pending) send(id, message);
    });
    link.on('data', packet => {
      if (packet?.kind === 'game' && guests.get(id) === guest && !guest.pending) {
        onMessage?.(id, packet.message);
      }
    });
  });
  function reconnect() {
    if (roomClosed || peer.destroyed || !peer.disconnected) return;
    peer.reconnect();
  }
  peer.on('disconnected', () => {
    clearTimeout(reconnectTimer);
    if (!roomClosed) reconnectTimer = setTimeout(reconnect, 2000);
  });
  peer.on('error', error => {
    if (!roomClosed && error.type !== 'peer-unavailable') onError?.(connectionError(error));
  });
  return {code, send, drop, close};
}

export async function joinRoom(rawCode, rawName, {onMessage, onClose, onError, signal, intent = 'play'} = {}) {
  const code = normalizeRoomCode(rawCode);
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('여섯 자리 방 코드를 입력해 주세요.');
  const name = String(rawName ?? '').trim();
  if (!name || name.length > 32) throw new Error('닉네임은 1~32자로 입력해 주세요.');
  const peer = await openPeer(CHANNEL + '-guest-' + randomCode(16), signal);
  if (signal?.aborted) {
    peer.destroy();
    throw cancelled();
  }
  return new Promise((resolve, reject) => {
    let accepted = false;
    let finished = false;
    let link;
    const timer = setTimeout(() => end('방장과 연결하지 못했습니다. 방 코드와 네트워크를 확인해 주세요.'), CONNECT_TIMEOUT);
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    function end(reason, silently = false) {
      if (finished) return;
      finished = true;
      cleanup();
      peer.destroy();
      if (!accepted) reject(new Error(reason));
      else if (!silently) onClose?.(reason);
    }
    function abort() { end('연결을 취소했습니다.'); }
    function close() { end('방에서 나왔습니다.', true); }
    function send(message) {
      if (!accepted || finished || !link.open) return false;
      link.send({kind: 'game', message});
      return true;
    }
    signal?.addEventListener('abort', abort, {once: true});
    peer.on('error', error => {
      if (finished) return;
      const detail = connectionError(error);
      if (!accepted || peer.destroyed) end(detail.message);
      else if (error.type !== 'network' && error.type !== 'disconnected') onError?.(detail);
    });
    peer.on('close', () => end('방장과의 연결이 종료되었습니다.'));
    peer.on('connection', incoming => incoming.close());
    try {
      link = peer.connect(CHANNEL + '-' + code, {
        label: CHANNEL, reliable: true, serialization: 'binary', metadata: {name, intent}
      });
    } catch {
      end('방장과 연결할 수 없습니다. 다시 시도해 주세요.');
      return;
    }
    if (!link) {
      end('방장과 연결할 수 없습니다. 다시 시도해 주세요.');
      return;
    }
    watchLink(link, () => end('방장과의 연결이 종료되었습니다.'));
    link.on('data', packet => {
      if (finished || !packet) return;
      if (packet.kind === 'bye') {
        end(typeof packet.reason === 'string' ? packet.reason : '방에서 퇴장했습니다.');
      } else if (!accepted && packet.kind === 'welcome') {
        accepted = true;
        cleanup();
        resolve({code, send, close});
      } else if (accepted && packet.kind === 'game') {
        onMessage?.(packet.message);
      }
    });
  });
}
