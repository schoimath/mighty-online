import {normalizeGameSpeed, tableDelay} from './table-timing.js';

// A bearer token goes directly to the configured game service. Peers exchange
// hand IDs and one-hand consent notices, never tokens or personal projections.
export async function callChipService(client, payload) {
  if (!client.url || !client.publishableKey) throw new Error('게임 계정 서버 연결이 필요합니다.');
  const token = payload.op === 'watch' ? null : await client.accessToken();
  if (!['watch','room-takeover','room-pace','room-auto-play'].includes(payload.op) && !token) throw new Error('이메일 확인 후 로그인해 주세요.');
  const headers = {'Content-Type':'application/json', apikey:client.publishableKey};
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(client.url.replace(/\/$/, '') + '/functions/v1/chip-hand', {
    method:'POST', headers, body:JSON.stringify(payload), cache:'no-store', redirect:'error', signal:AbortSignal.timeout(20000)
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

function dealPace(value = 'normal') {
  return normalizeGameSpeed(value) === value ? value : null;
}

function dealAutoPlay(value = true) {
  return typeof value === 'boolean' ? value : null;
}

export function chipManifest(plan, room, host, accounts) {
  const pace = dealPace(plan.pace);
  if (!pace) throw new Error('대국 속도를 확인해 주세요.');
  const autoPlay = dealAutoPlay(plan.autoPlay);
  if (autoPlay === null) throw new Error('10초 자동진행 설정을 확인해 주세요.');
  const seats = plan.seats.map(p => p.bot ? null : accounts.get(p.id));
  if (!accountIdValid(host) || seats.some(id => id !== null && !accountIdValid(id))) {
    throw new Error('모든 참가자가 계정에 로그인한 뒤 다시 입장해 주세요.');
  }
  const humans = seats.filter(Boolean);
  if (!humans.length) throw new Error('칩 대국에는 칩을 보유한 참가자가 한 명 이상 필요합니다.');
  if (new Set(humans).size !== humans.length) throw new Error('한 계정은 한 자리에서만 참가할 수 있습니다.');
  return {handId:crypto.randomUUID(), room, host, seats, names:plan.seats.map(p => p.name),
    models:plan.models, rules:plan.rules, firstSeat:plan.firstSeat, ...(pace === 'normal' ? {} : {pace}),
    ...(autoPlay ? {} : {autoPlay:false})};
}

export function offeredSeat(snapshot, spec, room, userId) {
  if (!snapshot || !spec || (snapshot.game && snapshot.game.phase !== 'result') || spec.room !== room ||
      !accountIdValid(spec.handId) || !accountIdValid(userId) || spec.host !== snapshot.chipHost ||
      !Array.isArray(spec.seats) || spec.seats.length !== 5) return -1;
  const pace = dealPace(spec.pace);
  if (!pace || pace !== dealPace(snapshot.pace)) return -1;
  const autoPlay = dealAutoPlay(spec.autoPlay);
  if (autoPlay === null || autoPlay !== dealAutoPlay(snapshot.autoPlay)) return -1;
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

function sameDecisionAfterUpdate(previous, next) {
  if (!previous || previous.handId !== next.handId) return false;
  const settingsChanged = normalizeGameSpeed(previous.pace) !== normalizeGameSpeed(next.pace) ||
    dealAutoPlay(previous.autoPlay) !== dealAutoPlay(next.autoPlay);
  const renewedPresence = previous.turnDeadline === null && next.turnDeadline === null &&
    next.bots?.[next.game?.turn] === false && Number.isFinite(previous.dueAt) && next.dueAt > previous.dueAt;
  if (!settingsChanged && !renewedPresence) return false;
  return previous.seat === next.seat && ['game','publicGame','names','bots','models'].every(
    field => JSON.stringify(previous[field]) === JSON.stringify(next[field]));
}

function sameDealAndSeat(first, next) {
  return first.handId === next.handId && first.seat === next.seat && first.game.dealNo === next.game.dealNo;
}

function cardHasLeft(first, next, card) {
  if (!sameDealAndSeat(first, next) || next.revision <= first.revision ||
      (next.game.phase !== 'play' && next.game.phase !== 'result') ||
      !Array.isArray(next.game.hand) || next.game.hand.includes(card)) return false;
  if (!next.game.result?.setting) return true;
  // A setting clears every hand, including unplayed cards. Its final friend
  // trick can still confirm a card the player actually put on the table.
  const last = next.game.lastTrick;
  const matches = play => play?.seat === first.seat && play.card === card;
  return last?.number === first.game.trickNo && Boolean(last?.cards?.some(matches) || matches(last?.finalPlay));
}

export function followChipHand(request, handId, op, onState, onError, initial, {publicTable, isVisible} = {}) {
  let current = null, closed = false, timer, busy = false, writing = null, submitting = false, changingPace = false, failures = 0;
  let wakeRevision = -1, wakeAfterRead = false;
  let requestOrder = 0, acceptedOrder = 0;
  let clockOffset = null;
  let playCursor = null, turnObservedAt = 0;
  function accept(data, order) {
    if (closed || data.handId !== handId || !data.game || (current && data.revision < current.revision)) return;
    if (current && data.revision === current.revision && order < acceptedOrder) return;
    // An unchanged turn can last longer than a cursor's lifetime. Keep the
    // renewed proof for the next read without repainting the current turn.
    playCursor = typeof data.playCursor === 'string' ? data.playCursor : null;
    if (Number.isFinite(data.serverNow)) {
      // A delayed response should never give a player extra time on the clock.
      const offset = Date.now() - data.serverNow;
      clockOffset = Math.min(clockOffset ?? offset, offset);
    }
    if (current && data.revision === current.revision) {
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
    const settingsOnly = sameDecisionAfterUpdate(current, data);
    if (!current || current.game.phase !== data.game.phase || current.game.turn !== data.game.turn ||
        current.game.trickNo !== data.game.trickNo || current.game.dealNo !== data.game.dealNo) {
      turnObservedAt = Date.now();
    }
    current = data;
    onState(data, false, settingsOnly);
  }
  function schedule(delay) {
    clearTimeout(timer);
    if (!closed && current?.game.phase !== 'result') timer = setTimeout(read, delay);
  }
  function scheduleNext() {
    if (busy || writing || closed) return;
    const due = current?.dueAt;
    const remaining = due + (clockOffset ?? 0) - Date.now();
    let minimumWait = current?.turnDeadline === due && remaining > 0 ? 0 : tableDelay(450, current?.pace);
    let maximumWait = 3200;
    if (current?.game.phase === 'play' && publicTable?.() && isVisible?.()) {
      const turn = current.game.turn;
      if (current.bots?.[turn] === true) {
        // A slow response may already have consumed most of the delay to
        // the next bot. Read close to its scheduled turn in that case.
        minimumWait = 120;
      } else if (current.bots?.[turn] === false && current.seat !== turn) {
        // The server table has no peer wake-up for another person's click.
        // Follow quick plays closely, then ease off while someone is thinking.
        const thinking = Date.now() - turnObservedAt;
        if (thinking < 4000) maximumWait = 800;
        else if (thinking < 10000) maximumWait = 1600;
      }
    }
    const delay = Number.isFinite(due) ? Math.min(maximumWait, Math.max(minimumWait, remaining + 50)) : Math.min(maximumWait,2600);
    if (failures) schedule(Math.min(12000, 2000 * failures));
    else if (wakeAfterRead || wakeRevision > (current?.revision ?? -1)) schedule(0);
    else schedule(delay);
  }
  async function read() {
    if (closed || busy || writing) return;
    busy = true;
    wakeAfterRead = false;
    wakeRevision = -1;
    const order = ++requestOrder;
    try {
      accept(await request(withCursor({op, handId})), order);
      failures = 0;
    } catch (error) {
      if (!closed && !failures++) onError(error);
    } finally {
      busy = false;
      scheduleNext();
    }
  }
  function withCursor(payload) {
    return playCursor ? {...payload, playCursor} : payload;
  }
  // Table setting edits and card plays from one browser must use successive server revisions.
  function write(operation) {
    const previous = writing;
    const job = (previous ?? Promise.resolve()).catch(() => {}).then(() => {
      if (!closed) return operation();
    });
    writing = job;
    return job.finally(() => {
      if (writing === job) { writing = null; scheduleNext(); }
    });
  }
  async function send(payload) {
    const order = ++requestOrder;
    const data = await request(withCursor({...payload, handId}));
    accept(data, order);
    return data;
  }
  async function sendAction(before, action) {
    let response = await send({op:'act', revision:before.revision, action});
    // A table option or a renewed presence lease can advance the revision without a move.
    if (!closed && response.handId === handId && response.revision > before.revision &&
        sameDecisionAfterUpdate(before, response) && sameDecisionAfterUpdate(before, current)) {
      response = await send({op:'act', revision:current.revision, action});
    }
    if (action.type === 'play' && !response.game) throw new Error('게임 서버 응답을 확인하지 못했습니다.');
  }
  const result = {handId, get current() { return current; },
    get localTurnDeadline() {
      return Number.isFinite(current?.turnDeadline) ? current.turnDeadline + (clockOffset ?? 0) : null;
    },
    get localThinkingDeadline() {
      return Number.isFinite(current?.thinkingDeadline) ? current.thinkingDeadline + (clockOffset ?? 0) : null;
    },
    start() { if (initial) accept(initial, 0); schedule(0); },
    refresh() { return write(() => send({op})); },
    wake(revision) {
      if (closed || current?.game.phase === 'result') return;
      if (Number.isSafeInteger(revision)) {
        if (revision <= (current?.revision ?? -1)) return;
        wakeRevision = Math.max(wakeRevision, revision);
      } else wakeAfterRead = true;
      if (!busy && !writing) schedule(0);
    },
    async act(action) {
      const play = action?.type === 'play';
      const selected = current;
      if (closed || submitting || !selected || selected.seat < 0 || selected.game.turn !== selected.seat ||
          (play && (selected.game.phase !== 'play' || !selected.game.hand?.includes(action.card)))) {
        return play ? false : undefined;
      }
      submitting = true;
      try {
        const confirmed = await write(async () => {
          const before = current;
          if (before.seat < 0 || before.game.turn !== before.seat || before.game.result) return;
          // A timeout can bring this seat to another decision while a write is
          // queued. A settings edit or renewed lease preserves the original choice.
          if (selected.revision !== before.revision && !sameDecisionAfterUpdate(selected, before)) return;
          if (!play) return sendAction(before, action);
          if (!sameDealAndSeat(selected, before) || before.game.phase !== 'play' ||
              selected.game.trickNo !== before.game.trickNo || !before.game.hand?.includes(action.card)) return false;
          try {
            await sendAction(before, action);
          } catch (error) {
            if (closed) return false;
            if (error.status && error.status < 500 && error.status !== 408) throw error;
            // The server may have saved the play before the reply was lost.
            // Verify with a private read. Re-sending the mutation is unsafe.
            if (cardHasLeft(before, current, action.card)) return true;
            let failure = error;
            try { await send({op}); } catch (readError) { failure = readError; }
            if (!closed && !cardHasLeft(before, current, action.card)) throw failure;
          }
          return !closed && cardHasLeft(before, current, action.card);
        });
        return play ? confirmed === true : undefined;
      } finally { submitting = false; }
    },
    async changePace(pace) {
      if (closed || changingPace) return current;
      if (op !== 'view' || !current?.publicGame || current.game.result || !dealPace(pace) || !pace) {
        throw new Error('진행 중인 판의 방장만 속도를 변경할 수 있습니다.');
      }
      changingPace = true;
      try {
        await write(async () => {
          if (current.game.result || normalizeGameSpeed(current.pace) === pace) return;
          await send({op:'pace', pace});
        });
        return current;
      } finally { changingPace = false; }
    },
    async changeAutoPlay(autoPlay) {
      if (closed) return current;
      if (op !== 'view' || !current?.publicGame || current.game.result) {
        throw new Error('진행 중인 판의 방장만 10초 자동진행을 변경할 수 있습니다.');
      }
      if (typeof autoPlay !== 'boolean') throw new Error('10초 자동진행 설정을 확인해 주세요.');
      await write(async () => {
        if (!current.game.result && dealAutoPlay(current.autoPlay) !== autoPlay) {
          await send({op:'auto-play', autoPlay});
        }
      });
      return current;
    },
    close() { closed = true; clearTimeout(timer); }
  };
  return result;
}
