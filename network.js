const CHANNEL = 'mighty-online-v1';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CONNECT_TIMEOUT = 20000;

export function normalizeRoomCode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
}

function roomPeerId(code, route) {
  const base = CHANNEL + '-' + code;
  if (route == null) return base;
  if (typeof route !== 'string' || !/^[a-f0-9]{32}$/i.test(route)) throw new Error('테이블의 연결 주소를 다시 확인해 주세요.');
  return base + '-' + route.toLowerCase();
}

function randomCode(length) {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)),
    byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

const cancelled = () => new Error('연결을 취소했습니다.');

function waitForCodeRelease(delay,signal) {
  return new Promise((resolve,reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    function abort() { clearTimeout(timer); reject(cancelled()); }
    const timer = setTimeout(() => { signal?.removeEventListener('abort',abort); resolve(); },delay);
    signal?.addEventListener('abort',abort,{once:true});
  });
}

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
  result.retryable = !error || ['peer-unavailable','webrtc','network','disconnected','socket-error','socket-closed','server-error'].includes(error.type);
  return result;
}

export async function openPeer(id, signal, timeout = CONNECT_TIMEOUT) {
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
    const timer = setTimeout(() => fail(connectionError()), timeout);
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
  return () => { done = true; clearTimeout(timer); };
}

function goodbye(link, reason) {
  if (!link.open) {
    link.close();
    return;
  }
  link.send({kind: 'bye', reason});
  link.close({flush: true});
  if (link.open) {
    const timer = setTimeout(() => link.close(), 1500);
    link.once('close', () => clearTimeout(timer));
  }
}

export async function hostRoom({onJoin, onMessage, onLeave, onError, signal, reclaimCode, signalRoute, waitForCode = false} = {}) {
  let code, peer;
  if (reclaimCode && !/^[A-Z0-9]{6}$/.test(reclaimCode)) throw new Error('방 코드를 확인해 주세요.');
  const attempts = reclaimCode ? (waitForCode ? 3 : 1) : 4;
  for (let attempt = 0; attempt < attempts; attempt++) {
    code = reclaimCode || randomCode(6);
    try {
      peer = await openPeer(roomPeerId(code,signalRoute), signal);
      break;
    } catch (error) {
      if (error.type !== 'unavailable-id' || attempt + 1 === attempts) throw error;
      if (reclaimCode) await waitForCodeRelease(350 * (attempt+1),signal);
    }
  }
  if (signal?.aborted) {
    peer.destroy();
    throw cancelled();
  }
  const guests = new Map();
  const endpoints = new Map();
  const links = new Map();
  const aliasOpening = new AbortController();
  let roomClosed = false;
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
    aliasOpening.abort();
    guests.clear();
    for (const dispose of links.values()) dispose();
    links.clear();
    for (const [endpoint,timer] of endpoints) { clearTimeout(timer); endpoint.destroy(); }
    endpoints.clear();
  }
  function accept(link) {
    if (roomClosed) { link.close(); return; }
    let id = String(nextId++);
    const guest = {link, pending: []};
    const timer = setTimeout(() => link.close(), CONNECT_TIMEOUT);
    const stopWatch = watchLink(link, () => {
      links.delete(link);
      clearTimeout(timer);
      if (guests.get(id) !== guest) return;
      guests.delete(id);
      if (!guest.pending && !roomClosed) onLeave?.(id);
    });
    links.set(link, () => { clearTimeout(timer); stopWatch(); });
    link.on('open', async () => {
      clearTimeout(timer);
      const name = link.metadata?.name;
      if (roomClosed || link.label !== CHANNEL || typeof name !== 'string' || !name.trim() || name.length > 32) {
        goodbye(link, '입장 정보를 확인하고 다시 시도해 주세요.');
        return;
      }
      const memberKey = link.metadata?.memberKey;
      if (typeof memberKey === 'string' && /^[a-f0-9-]{72}$/.test(memberKey)) {
        // Only the returning browser has the key. Checkpoints contain its digest.
        const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(memberKey));
        id = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2,'0')).join('');
        if (!link.open || roomClosed) return;
      }
      if (guests.has(id)) { goodbye(link, '이 연결은 이미 방에 있습니다.'); return; }
      guests.set(id, guest);
      let decision;
      try {
        decision = onJoin?.(id, name.trim(), link.metadata?.intent, link.metadata?.accountId,
          {canInherit:id.length === 64, roomId:link.metadata?.returnRoom});
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
  }
  function listen(endpoint) {
    if (roomClosed) { endpoint.destroy(); return; }
    endpoints.set(endpoint,null);
    endpoint.on('connection', accept);
    endpoint.on('disconnected', () => {
      if (roomClosed) return;
      clearTimeout(endpoints.get(endpoint));
      endpoints.set(endpoint,setTimeout(() => {
        if (!roomClosed && !endpoint.destroyed && endpoint.disconnected) endpoint.reconnect();
      },2000));
    });
    endpoint.on('error', error => {
      if (!roomClosed && endpoint === peer && error.type !== 'peer-unavailable') onError?.(connectionError(error));
    });
  }
  listen(peer);
  if (signalRoute && /^PUB00[1-4]$/.test(code)) {
    // Older clients still dial the fixed address. Its previous owner may
    // briefly retain it after this new table has acquired the directory slot.
    void openPeer(roomPeerId(code),aliasOpening.signal).then(listen, () => {});
  }
  return {code, send, drop, close};
}

export async function joinRoom(rawCode, rawName, {onMessage, onClose, onError, onProgress, signal, signalRoute, intent = 'play', accountId, memberKey, returnRoom, timeout = CONNECT_TIMEOUT} = {}) {
  const code = normalizeRoomCode(rawCode);
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('여섯 자리 방 코드를 입력해 주세요.');
  const address = roomPeerId(code,signalRoute);
  const name = String(rawName ?? '').trim();
  if (!name || name.length > 32) throw new Error('닉네임은 1~32자로 입력해 주세요.');
  const started = Date.now();
  onProgress?.('연결 서버에 접속 중…');
  const peer = await openPeer(CHANNEL + '-guest-' + randomCode(16), signal, timeout);
  if (signal?.aborted) {
    peer.destroy();
    throw cancelled();
  }
  return new Promise((resolve, reject) => {
    let welcomed = false;
    let accepted = false;
    let finished = false;
    let link;
    const initial = [];
    const timer = setTimeout(() => unavailable(welcomed ? '방 정보를 받지 못했습니다. 잠시 후 다시 참가해 주세요.' :
      '방장이 응답하지 않습니다. 테이블을 다시 확인해 주세요.'), Math.max(1, timeout - (Date.now() - started)));
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    function end(reason, silently = false, removed = false) {
      if (finished) return;
      finished = true;
      cleanup();
      peer.destroy();
      if (!accepted) reject(reason instanceof Error ? reason : new Error(reason));
      else if (!silently) onClose?.(reason instanceof Error ? reason.message : reason, removed);
    }
    function unavailable(message) { end(Object.assign(new Error(message),{retryable:true})); }
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
      if (!accepted || peer.destroyed) end(detail);
      else if (error.type !== 'network' && error.type !== 'disconnected') onError?.(detail);
    });
    peer.on('close', () => unavailable('방장과의 연결이 종료되었습니다.'));
    peer.on('connection', incoming => incoming.close());
    try {
      onProgress?.('대기실에 연결 중…');
      link = peer.connect(address, {
        label: CHANNEL, reliable: true, serialization: 'binary', metadata: {name, intent, accountId, memberKey, returnRoom}
      });
    } catch {
      unavailable('방장과 연결할 수 없습니다. 다시 시도해 주세요.');
      return;
    }
    if (!link) {
      unavailable('방장과 연결할 수 없습니다. 다시 시도해 주세요.');
      return;
    }
    watchLink(link, () => unavailable('방장과의 연결이 종료되었습니다.'));
    link.on('data', packet => {
      if (finished || !packet) return;
      if (packet.kind === 'bye') {
        end(typeof packet.reason === 'string' ? packet.reason : '방에서 퇴장했습니다.', false, true);
      } else if (packet.kind === 'welcome') {
        welcomed = true;
        if (!accepted) onProgress?.('대기실 정보를 받는 중…');
      } else if (welcomed && packet.kind === 'game') {
        const message = packet.message;
        if (accepted) { onMessage?.(message); return; }
        // Welcome confirms the peer link. Only the first roster lets the
        // application enter a usable room. Keep the join cancelable until then.
        if (message?.type === 'state') {
          if (!Array.isArray(message.view?.players) || message.view.players.length !== 5 ||
              !Number.isInteger(message.view.seat) || message.view.seat < -1 || message.view.seat > 4) {
            end('방의 참가자 정보를 읽지 못했습니다. 다시 참가해 주세요.');
            return;
          }
          try {
            for (const saved of initial) onMessage?.(saved);
            initial.length = 0;
            onMessage?.(message);
          } catch {
            end('방의 참가자 정보를 읽지 못했습니다. 다시 참가해 주세요.');
            return;
          }
          if (finished) return;
          accepted = true;
          cleanup();
          resolve({code, send, close});
        } else initial.push(message);
      }
    });
  });
}
