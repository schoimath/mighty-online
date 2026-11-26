const credentialFormat = /^[0-9a-f]{64}$/;
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

export function newChatCredential() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

async function digestCredential(credential) {
  if (!credentialFormat.test(credential)) throw new Error('방 인계 정보를 확인해 주세요.');
  const raw = new TextEncoder().encode(credential);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
}

// The credential belongs to exactly one controller. Only the intended backup
// receives its own distinct credential over its admitted peer connection.
export function createRoomChatStore(client, room, id = crypto.randomUUID(), credential = newChatCredential()) {
  if (!credentialFormat.test(credential)) throw new Error('방 인계 정보를 확인해 주세요.');
  let term = 0, opening = null;
  let writes = Promise.resolve(), roster = Promise.resolve();

  async function rpc(operation, args) {
    await (client.identityReady ?? client.ready);
    const userId = client.state.user?.id;
    const headers = {apikey:client.publishableKey, 'Content-Type':'application/json'};
    if (userId) {
      const token = await client.accessToken();
      if (!token || client.state.user?.id !== userId) throw new Error('로그인 상태를 확인해 주세요.');
      headers.Authorization = 'Bearer ' + token;
    }
    const response = await fetch(client.url + '/rest/v1/rpc/mighty_room_chat_' + operation, {
      method:'POST', headers, cache:'no-store', redirect:'error', signal:AbortSignal.timeout(8000),
      body:JSON.stringify({p_room_id:id, p_credential:credential, ...args})
    });
    const body = await response.text();
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? '이 방을 운영할 권한을 확인해 주세요.' : '방 채팅 서버와 연결하지 못했습니다.';
      throw Object.assign(new Error(message), {status:response.status});
    }
    return body ? JSON.parse(body) : null;
  }

  function open() {
    if (term) return Promise.resolve(term);
    if (!opening) opening = rpc('open', {p_room:room}).then(value => {
      if (!Number.isInteger(value) || value < 1) throw new Error('방 연결을 확인해 주세요.');
      term = value;
      return term;
    }).finally(() => { opening = null; });
    return opening;
  }
  async function run(operation, args) {
    await open();
    return rpc(operation, {p_term:term, ...args});
  }

  return {
    id, credential, get term() { return term; }, open,
    append({requestId, seat, name, text}) {
      const task = writes.then(() => run('append', {p_request:requestId, p_seat:seat, p_name:name, p_text:text}));
      writes = task.catch(() => {});
      return task;
    },
    linkHand(handId) { return run('link_hand', {p_hand:handId}); },
    setSuccessors(candidates) {
      const task = roster.then(async () => {
        const successors = await Promise.all(candidates.map(async candidate => ({
          accountId:candidate.accountId ?? null, digest:await digestCredential(candidate.credential)
        })));
        return run('successors', {p_successors:successors});
      });
      roster = task.catch(() => {});
      return task;
    },
    transfer(candidateCredential) {
      const task = roster.then(async () => run('transfer', {p_digest:await digestCredential(candidateCredential)}));
      roster = task.catch(() => {});
      return task;
    },
    async claim(previousTerm) {
      const newTerm = await rpc('claim', {p_term:previousTerm});
      if (!Number.isSafeInteger(newTerm) || newTerm<=0 || newTerm<previousTerm) return false;
      term = newTerm;
      return true;
    }
  };
}
