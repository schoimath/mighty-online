import {accountIdValid} from './chip-play.js';

export const PUBLIC_ROOM_LIMIT = 4;
export const PRIVATE_ROOM_LIMIT = 6;
const HEARTBEAT_MS = 20000;
const validSignalRoute = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

async function requestHeaders(client, isPublic) {
  const headers = {apikey:client.publishableKey, 'Content-Type':'application/json'};
  if (!isPublic) {
    await (client.identityReady ?? client.ready);
    const userId = client.state.user?.id;
    if (userId) {
      const token = await client.accessToken();
      if (!token || client.state.user?.id !== userId) throw new Error('로그인 상태를 확인해 주세요.');
      headers.Authorization = 'Bearer ' + token;
    }
  }
  return headers;
}

async function rpc(client, operation, args, {signal, isPublic = false, headers, keepalive = false} = {}) {
  headers ??= await requestHeaders(client,isPublic);
  const timeout = AbortSignal.timeout(8000);
  const response = await fetch(client.url + '/rest/v1/rpc/mighty_directory_' + operation, {
    method:'POST', headers, body:JSON.stringify(args), cache:'no-store', redirect:'error', keepalive,
    signal:signal ? AbortSignal.any([timeout,signal]) : timeout
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const message = ['P0001','P0002','22023'].includes(error.code) && error.message
      ? error.message : response.status === 401 || response.status === 403
        ? '이 방을 운영할 권한을 확인해 주세요.' : '테이블 목록 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.';
    throw Object.assign(new Error(message), {status:response.status, code:error.code});
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function listPublicRooms({signal,client} = {}) {
  client ??= (await import('./account-client.js')).accountClient;
  const rooms = await rpc(client,'list',{}, {signal,isPublic:true});
  if (!Array.isArray(rooms) || rooms.length !== PUBLIC_ROOM_LIMIT ||
      !rooms.every((room, i) => room.slot === i + 1 && room.code === 'PUB00' + (i + 1) &&
        ['empty','waiting','playing','finished','settling'].includes(room.phase) &&
        (room.watchHandId == null || (room.phase === 'settling' && accountIdValid(room.watchHandId))) &&
        (room.signalRoute == null || validSignalRoute(room.signalRoute)))) {
    throw new Error('공개 테이블 목록을 불러오지 못했습니다. 다시 시도해 주세요.');
  }
  return rooms;
}

export async function reserveDirectoryRoom(client,{store,code,slot = null,name,hostName}) {
  const result = await rpc(client,slot === null ? 'open' : 'open_routed',{p_room_id:store.id,p_credential:store.credential,p_code:code,
    p_slot:slot,p_name:name || '비공개 테이블',p_host:hostName});
  if (result?.code !== code || typeof result.claimed !== 'boolean' ||
      (result.signalRoute != null && (slot === null || !validSignalRoute(result.signalRoute))) ||
      !Number.isInteger(result.slot) || (slot !== null ? result.slot !== slot :
        (result.slot <= PUBLIC_ROOM_LIMIT || result.slot > PUBLIC_ROOM_LIMIT + PRIVATE_ROOM_LIMIT))) {
    throw new Error('방 정보를 확인하지 못했습니다. 다시 시도해 주세요.');
  }
  return result;
}

function publicSummary(summary) {
  if (!summary?.phase) return null;
  const {hostName,phase,humanCount,spectatorCount,reservationCount,roundNumber,roundLimit} = summary;
  const fields = {hostName,phase,humanCount,spectatorCount,reservationCount,roundNumber,roundLimit};
  if (validSignalRoute(summary.signalRoute)) fields.signalRoute = summary.signalRoute;
  const seats = summary.seats;
  if (Array.isArray(seats) && seats.length === 5 &&
      seats.every(name => name === null || (typeof name === 'string' && name.trim() && name.length <= 16)) &&
      seats.filter(name => name !== null).length === humanCount) fields.seats = seats;
  return fields;
}

export function watchDirectoryRoom(client,{store,getSummary,onError,canReleaseOnPageHide}) {
  let stopped = false, warned = false, lastSummary, lastSent = 0;
  let queued = Promise.resolve(), closing, release;
  async function args() {
    const term = store.term || await store.open();
    return {p_room_id:store.id,p_credential:store.credential,p_term:term};
  }
  function refresh() {
    const task = queued.then(async () => {
      if (stopped) return;
      const summary = publicSummary(getSummary?.());
      const fingerprint = JSON.stringify(summary);
      if (lastSummary === fingerprint && Date.now() - lastSent < HEARTBEAT_MS) return;
      const identity = await args();
      const userId = client.state.user?.id;
      const headers = await requestHeaders(client,false);
      if (stopped || client.state.user?.id !== userId) return;
      // Prepare the last host's small close request while the page is active.
      // Waiting for an auth refresh inside pagehide can outlive the document.
      if (canReleaseOnPageHide) release = {identity, headers, userId};
      await rpc(client,'refresh',{...identity,p_summary:summary},{headers});
      lastSummary = fingerprint;
      lastSent = Date.now();
      warned = false;
    });
    queued = task.catch(error => {
      if (!stopped && !warned) { warned = true; onError?.(error); }
      if (error.code === 'P0002' || error.status === 403) stop();
    });
    return queued;
  }
  function stop() {
    stopped = true;
    release = null;
    clearInterval(ticker);
    globalThis.document?.removeEventListener('visibilitychange', visible);
  }
  function close() {
    stop();
    closing ??= queued.then(async () => rpc(client,'close',await args())).catch(error => {
      onError?.(error);
    });
    return closing;
  }
  function visible() {
    if (globalThis.document?.visibilityState === 'visible') refresh();
  }
  function leavePage() {
    if (stopped) return closing;
    const lastHost = canReleaseOnPageHide?.();
    const grant = release;
    stop();
    if (!lastHost || (grant && (grant.identity.p_term !== store.term || grant.userId !== client.state.user?.id))) {
      closing = Promise.resolve();
      return closing;
    }
    // Cached and discarded pages both lose their live signaling connection.
    // Use the prepared grant synchronously before the browser freezes the page.
    closing = (grant ? rpc(client,'close',grant.identity,{headers:grant.headers,keepalive:true}) :
      args().then(identity => rpc(client,'close',identity,{keepalive:true}))).catch(() => {});
    return closing;
  }
  const ticker = setInterval(refresh,HEARTBEAT_MS);
  globalThis.document?.addEventListener('visibilitychange', visible);
  refresh();
  return {refresh,stop,close,leavePage};
}
