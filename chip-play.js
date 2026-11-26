// A bearer token goes directly to the configured game service. Peers exchange
// hand IDs and one-hand consent notices, never tokens or personal projections.
export async function callChipService(client, payload) {
  if (!client.url || !client.publishableKey) throw new Error('게임 계정 서버 연결이 필요합니다.');
  const token = payload.op === 'watch' ? null : await client.accessToken();
  if (payload.op !== 'watch' && !token) throw new Error('이메일 확인 후 로그인해 주세요.');
  const headers = {'Content-Type':'application/json', apikey:client.publishableKey};
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(client.url.replace(/\/$/, '') + '/functions/v1/chip-hand', {
    method:'POST', headers, body:JSON.stringify(payload), cache:'no-store', signal:AbortSignal.timeout(20000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const error = new Error(data.error || '게임 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    error.code = data.code;
    error.status = res.status;
    throw error;
  }
  return data;
}

export const accountIdValid = id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

export function chipManifest(plan, room, host, accounts) {
  const seats = plan.seats.map(p => p.bot ? null : accounts.get(p.id));
  if (!accountIdValid(host) || seats.some(id => id !== null && !accountIdValid(id))) {
    throw new Error('모든 참가자가 계정에 로그인한 뒤 다시 입장해 주세요.');
  }
  const humans = seats.filter(Boolean);
  if (!humans.length) throw new Error('칩 대국에는 칩을 보유한 참가자가 한 명 이상 필요합니다.');
  if (new Set(humans).size !== humans.length) throw new Error('한 계정은 한 자리에서만 참가할 수 있습니다.');
  return {handId:crypto.randomUUID(), room, host, seats, names:plan.seats.map(p => p.name),
    models:plan.models, rules:plan.rules, firstSeat:plan.firstSeat};
}

export function offeredSeat(snapshot, spec, room, userId) {
  if (!snapshot || !spec || (snapshot.game && snapshot.game.phase !== 'result') || spec.room !== room ||
      !accountIdValid(spec.handId) || !accountIdValid(userId) || spec.host !== snapshot.chipHost ||
      !Array.isArray(spec.seats) || spec.seats.length !== 5) return -1;
  const seat = snapshot.spectator ? snapshot.reservation?.seat : snapshot.seat;
  if (!Number.isInteger(seat) || seat < 0 || seat > 4 || spec.seats[seat] !== userId) return -1;
  const next = snapshot.nextDeal;
  if (!next || next.firstSeat !== spec.firstSeat || next.seats.length !== 5 ||
      next.seats.some((p,i) => p.name !== spec.names?.[i] || p.bot !== (spec.seats[i] === null))) return -1;
  if (snapshot.botModels.some((model, i) => model !== spec.models?.[i]) ||
      Object.entries(snapshot.rules).some(([key, val]) => spec.rules?.[key] !== val)) return -1;
  return seat;
}

export function consentWindow(ids, handId, timeout = 30000) {
  const remaining = new Set(ids);
  let resolve, reject, timer;
  const ready = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  if (!remaining.size) resolve();
  else timer = setTimeout(() => reject(new Error('참가자 확인 시간이 지났습니다. 다시 시작해 주세요.')), timeout);
  return {handId, ready,
    answer(id, accepted, reason) {
      if (!remaining.delete(id)) return false;
      if (!accepted) { clearTimeout(timer); reject(reason || new Error('참가자가 이번 판에 참여할 수 없습니다.')); }
      else if (!remaining.size) { clearTimeout(timer); resolve(); }
      return true;
    },
    close() { clearTimeout(timer); reject(new Error('대국 준비가 취소되었습니다.')); }
  };
}

export function followChipHand(request, handId, op, onState, onError, initial) {
  let current = null, closed = false, timer, busy = false, submitting = false, failures = 0;
  let requestOrder = 0, acceptedOrder = 0;
  function accept(data, order) {
    if (closed || data.handId !== handId || !data.game || (current && data.revision < current.revision)) return;
    if (current && data.revision === current.revision) {
      if (order < acceptedOrder) return;
      acceptedOrder = order;
      const balances = data.seatBalances;
      if (!Array.isArray(balances) || balances.length !== 5 ||
          !balances.every(value => value === null || Number.isSafeInteger(value)) ||
          balances.every((value, seat) => value === current.seatBalances?.[seat])) return;
      // A wallet can change between turns. Keep the accepted game and its pending input intact.
      current = {...current, seatBalances:balances};
      onState(current, true);
      return;
    }
    acceptedOrder = order;
    current = data;
    onState(data);
  }
  function schedule(delay) {
    clearTimeout(timer);
    if (!closed && current?.game.phase !== 'result') timer = setTimeout(read, delay);
  }
  async function read() {
    if (closed || busy || submitting) return;
    busy = true;
    const order = ++requestOrder;
    try {
      accept(await request({op, handId}), order);
      failures = 0;
    } catch (error) {
      if (!closed && !failures++) onError(error);
    } finally {
      busy = false;
      const due = current?.dueAt;
      const delay = Number.isFinite(due) ? Math.min(3200, Math.max(450, due - Date.now() + 50)) : 2600;
      schedule(failures ? Math.min(12000, 2000 * failures) : delay);
    }
  }
  const result = {handId, get current() { return current; },
    start() { if (initial) accept(initial, 0); schedule(0); },
    wake() { if (!busy && !submitting) schedule(0); },
    async act(action) {
      if (closed || submitting || !current || current.seat < 0 || current.game.turn !== current.seat) return;
      submitting = true;
      const order = ++requestOrder;
      try { accept(await request({op:'act', handId, revision:current.revision, action}), order); }
      finally { submitting = false; schedule(0); }
    },
    close() { closed = true; clearTimeout(timer); }
  };
  return result;
}
