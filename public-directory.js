export const PUBLIC_ROOM_LIMIT = 4;
export const PRIVATE_ROOM_LIMIT = 6;
const HEARTBEAT_MS = 20000;

async function rpc(client, operation, args, {signal, isPublic = false} = {}) {
  const headers = {apikey:client.publishableKey, 'Content-Type':'application/json'};
  if (!isPublic) {
    await client.ready;
    const userId = client.state.user?.id;
    if (userId) {
      const token = await client.accessToken();
      if (!token || client.state.user?.id !== userId) throw new Error('로그인 상태를 확인해 주세요.');
      headers.Authorization = 'Bearer ' + token;
    }
  }
  const timeout = AbortSignal.timeout(8000);
  const response = await fetch(client.url + '/rest/v1/rpc/mighty_directory_' + operation, {
    method:'POST', headers, body:JSON.stringify(args), cache:'no-store', redirect:'error',
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
        ['empty','waiting','playing','finished','settling'].includes(room.phase))) {
    throw new Error('공개 테이블 목록을 불러오지 못했습니다. 다시 시도해 주세요.');
  }
  return rooms;
}

export async function reserveDirectoryRoom(client,{store,code,slot = null,name,hostName}) {
  const result = await rpc(client,'open',{p_room_id:store.id,p_credential:store.credential,p_code:code,
    p_slot:slot,p_name:name || '비공개 테이블',p_host:hostName});
  if (result?.code !== code || typeof result.claimed !== 'boolean' ||
      !Number.isInteger(result.slot) || (slot !== null ? result.slot !== slot :
        (result.slot <= PUBLIC_ROOM_LIMIT || result.slot > PUBLIC_ROOM_LIMIT + PRIVATE_ROOM_LIMIT))) {
    throw new Error('방 정보를 확인하지 못했습니다. 다시 시도해 주세요.');
  }
  return result;
}

function publicSummary(summary) {
  if (!summary?.phase) return null;
  const {hostName,phase,humanCount,spectatorCount,reservationCount,roundNumber,roundLimit} = summary;
  return {hostName,phase,humanCount,spectatorCount,reservationCount,roundNumber,roundLimit};
}

export function watchDirectoryRoom(client,{store,getSummary,onError}) {
  let stopped = false, warned = false, lastSummary, lastSent = 0;
  let queued = Promise.resolve(), closing;
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
      if (stopped) return;
      await rpc(client,'refresh',{...identity,p_summary:summary});
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
  const ticker = setInterval(refresh,HEARTBEAT_MS);
  globalThis.document?.addEventListener('visibilitychange', visible);
  refresh();
  return {refresh,stop,close};
}
