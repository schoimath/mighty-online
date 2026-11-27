import {botObservation, validateRules} from '../../../engine.js';
import {applyAction, canDeclareSetting, createGame, getSpectatorView, getView, resolveSetting} from '../../../table-deal.js';
import {analyzeSetting} from '../../../table-claim.js';
import {shouldDeclareSetting} from '../../../bot-setting.js';
import {settlements} from '../../../table-scoring.js';
import {jokerWasPlayed, withJokerStatus} from '../../../table-joker.js';
import {decideTableTurn, hasSeatMemory, isModelId, memoryForReplacement} from '../../../lab/table-agents.js';
import {botTurnDelay, normalizeGameSpeed, paceMultiplier} from '../../../table-timing.js';

const RECONNECT_MS = 120_000;
const HUMAN_TURN_MS = 10_000;
const THINKING_TIME_MS = 180_000;
const CATCHUP_BUDGET_MS = 120;
const MAX_UNATTENDED_MOVES = 64;
const SUBSTITUTE_NAMES = ['AI 솔', 'AI 달', 'AI 별', 'AI 구름', 'AI 바다'];
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const five = value => Array.isArray(value) && value.length === 5;
const check = (condition, message, status = 400) => {
  if (!condition) throw Object.assign(new Error(message), {status});
};

function manifestOf(request) {
  const {host, room, seats, names, models, firstSeat} = request;
  check(uuid(host) && typeof room === 'string' && /^[A-Z0-9]{6}$/.test(room), '방 정보가 올바르지 않습니다.');
  check(five(seats) && seats.every(id => id === null || uuid(id)), '참가자 계정을 확인해 주세요.');
  const normalized = seats.map(id => id && id.toLowerCase());
  const humans = normalized.filter(Boolean);
  check(humans.length && new Set(humans).size === humans.length, '서로 다른 계정으로 자리에 참가해 주세요.');
  check(five(names) && names.every(n => typeof n === 'string' && n.trim() && n.length <= 16), '자리별 닉네임을 확인해 주세요.');
  check(five(models) && models.every(isModelId), '자리별 AI 모델을 확인해 주세요.');
  check(Number.isInteger(firstSeat) && firstSeat >= 0 && firstSeat < 5, '첫 공약 자리를 확인해 주세요.');
  const pace = normalizeGameSpeed(request.pace);
  check(request.pace === undefined || pace === request.pace, '테이블 진행 속도를 확인해 주세요.');
  check(request.autoPlay === undefined || typeof request.autoPlay === 'boolean', '10초 자동진행 설정을 확인해 주세요.');
  // Keep default settings out of the hash so existing signed-off tables can start.
  return {host:host.toLowerCase(), room, seats:normalized, names:names.map(n => n.trim()),
    models, rules:validateRules(request.rules), firstSeat, ...(pace === 'normal' ? {} : {pace}),
    ...(request.autoPlay === false ? {autoPlay:false} : {})};
}

async function hashManifest(spec) {
  const bytes = new TextEncoder().encode(JSON.stringify(spec));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2,'0')).join('');
}

export function chipManifestDigest(input) {
  return hashManifest(manifestOf(input));
}

// The database serializes deal creation and validates every signed consent,
// including idempotent retries after a lost response.
async function startHand(db, hand, spec, hash, now) {
  const row = await db.start(hand, spec, createState(spec, hash, now));
  check(row.host === spec.host && row.state.manifest === hash, '이미 다른 조건으로 시작된 판입니다.', 409);
  return row;
}

export async function startPublicLobbyHand(input, db, now = Date.now()) {
  check(uuid(input.handId), '판 번호가 올바르지 않습니다.');
  const spec = manifestOf(input);
  const row = await startHand(db, input.handId.toLowerCase(), spec, await hashManifest(spec), now);
  return publicHandReceipt(row, now);
}

function usesTurnClock(state) {
  return state.autoPlay !== false && !state.round.result && !state.bots[state.round.turn] && state.bots.filter(bot => !bot).length >= 2;
}

function turnDeadline(state) {
  if (!usesTurnClock(state)) return null;
  // Older hands stored the start of this human turn plus its two-minute grace.
  return state.turnDeadline ?? state.dueAt - RECONNECT_MS + HUMAN_TURN_MS;
}

function scheduleTurn(state, now, botTime = now, previousSeat) {
  const g = state.round;
  // The deadline includes ten seconds of overtime. Save only the reserve
  // still unused by the previous actor; reads never consume or extend it.
  const banks = state.thinkingTime;
  const timed = usesTurnClock(state);
  let overtime = HUMAN_TURN_MS;
  if (banks && previousSeat === undefined) {
    // A toggle during overtime pauses and resumes the same decision.
    overtime = Number.isFinite(state.turnDeadline)
      ? Math.max(0, Math.min(HUMAN_TURN_MS, state.turnDeadline - now))
      : state.pausedOvertimeMs ?? HUMAN_TURN_MS;
  }
  if (banks && Number.isFinite(state.turnDeadline)) {
    const remaining = state.turnDeadline - HUMAN_TURN_MS - now;
    const seat = previousSeat ?? g.turn;
    banks[seat] = Math.max(0, Math.min(banks[seat], remaining));
  }
  if (banks) state.pausedOvertimeMs = !timed && overtime < HUMAN_TURN_MS ? overtime : null;
  state.turnDeadline = timed ? now + (banks?.[g.turn] ?? 0) + overtime : null;
  if (g.result) state.dueAt = null;
  else if (!state.bots[g.turn]) state.dueAt = state.turnDeadline ?? now + RECONNECT_MS;
  else state.dueAt = botTime + botTurnDelay(g, state.pace, {showRedeal:false});
}

function createState(spec, manifest, now) {
  const state = {manifest, names:spec.names, models:spec.models, firstSeat:spec.firstSeat, pace:normalizeGameSpeed(spec.pace), autoPlay:spec.autoPlay !== false,
    round:createGame({firstSeat:spec.firstSeat, rules:spec.rules}), bots:spec.seats.map(id => id === null),
    thinkingTime:spec.seats.map(id => id ? THINKING_TIME_MS : 0),
    history:Array.from({length:5}, () => []), memory:Array(5).fill(null), dueAt:null};
  scheduleTurn(state, now);
  return state;
}

function nameAt(row, seat) {
  return row.seats[seat] && row.state.bots[seat] && !row.state.round.result
    ? SUBSTITUTE_NAMES[seat] : row.state.names[seat];
}

function present(row, id, now) {
  const {state} = row, round = state.round;
  const owner = id ? row.seats.indexOf(id) : -1;
  const seat = owner >= 0 && !state.bots[owner] ? owner : -1;
  const seenJoker = jokerWasPlayed(round);
  const publicGame = (id === row.host || seat < 0) ? withJokerStatus(getSpectatorView(round), seenJoker) : null;
  const game = seat >= 0 ? withJokerStatus(getView(round, seat), seenJoker) : publicGame;
  if (game.phase === 'discard' && seat === game.declarer) game.incomingCards = [...round.knownKitty];
  const deltas = round.result ? settlements(round.result, round.bid.suit) : null;
  const deadline = turnDeadline(state);
  const thinkingDeadline = deadline !== null && state.thinkingTime?.[round.turn] > 0 ? deadline - HUMAN_TURN_MS : null;
  const seatBalances = row.seats.map((account, i) =>
    account && (!state.bots[i] || row.settled) && Number.isSafeInteger(row.seatBalances?.[i]) ? row.seatBalances[i] : null);
  return {handId:row.hand, room:row.room, revision:row.revision, seat, game, bots:state.bots,
    names:state.names.map((_, i) => nameAt(row, i)), seatBalances, models:state.models, firstSeat:state.firstSeat, pace:normalizeGameSpeed(state.pace),
    autoPlay:state.autoPlay !== false, dueAt:deadline ?? state.dueAt, turnDeadline:deadline, serverNow:now, lastTimedAction:state.lastTimedAction ?? null,
    thinkingDeadline, timeBankMs:state.thinkingTime ? THINKING_TIME_MS : 0,
    deltas, ...(owner >= 0 && deltas ? {myDelta:deltas[owner], mySettlementSeat:owner} : {}),
    ...(id === row.host ? {publicGame} : {})};
}

export function publicHandReceipt(row, now = Date.now()) {
  const receipt = present(row, null, now);
  return {...receipt, publicGame:receipt.game};
}

function replaceSeat(state, seat) {
  if (hasSeatMemory(state.models[seat])) {
    state.memory[seat] = memoryForReplacement(state.models[seat], state.history[seat]);
    state.history[seat] = [];
  }
  state.bots[seat] = true;
}

function move(row, action, now, memory = null, botTime = now) {
  const s = row.state, r = s.round, seat = r.turn, before = r.dealNo;
  const name = nameAt(row, seat);
  const track = !s.bots[seat] && hasSeatMemory(s.models[seat]);
  if (action?.type === 'claim') {
    check(canDeclareSetting(r, seat), '현재 세팅을 선언할 수 없습니다.');
    resolveSetting(r, seat, analyzeSetting(r));
  } else {
    applyAction(r, seat, action, undefined, track ? s.history[seat] : undefined);
    if (r.dealNo !== before) {
      s.memory.fill(null);
      s.history = Array.from({length:5}, () => []);
    } else if (!track && memory !== null) s.memory[seat] = memory;
    if (action.type === 'bid' || action.type === 'pass') {
      const entry = r.bidHistory.at(-1);
      if (entry) entry.name = name;
    }
  }
  scheduleTurn(s, now, botTime, seat);
  if (r.result) { s.memory.fill(null); s.history = []; }
}

function advanceDue(row, now, catchup) {
  const s = row.state;
  const allBots = s.bots.every(Boolean);
  const finishing = s.finishUnattended === true && allBots;
  let due = turnDeadline(s) ?? s.dueAt;
  if (s.round.result || due > now) return false;
  // The clock only replays elapsed turns. An account explicitly closing an
  // all-AI hand also waives the pauses between moves. Persist a bounded batch
  // so expensive bot decisions or repeated redeals can resume on another call.
  const limit = finishing || (catchup && allBots) ? MAX_UNATTENDED_MOVES : catchup ? 5 : 1;
  const deadline = performance.now() + CATCHUP_BUDGET_MS;
  for (let i = 0; i < limit && !s.round.result && due <= now; i++) {
    const seat = s.round.turn;
    const assisted = usesTurnClock(s);
    if (!assisted && !s.bots[seat]) replaceSeat(s, seat);
    const view = withJokerStatus(botObservation(s.round, seat));
    const memory = assisted ? memoryForReplacement(s.models[seat], s.history[seat]) : s.memory[seat];
    const next = !assisted && canDeclareSetting(s.round, seat) && shouldDeclareSetting(view)
      ? {action:{type:'claim'}}
      : decideTableTurn({modelId:s.models[seat], view, memory});
    move(row, next.action, now, next.memory, catchup && !finishing && !assisted ? due : now);
    if (assisted) s.lastTimedAction = {seat, revision:row.revision + 1};
    if (finishing && !s.round.result) s.dueAt = now;
    due = s.dueAt;
    if (performance.now() >= deadline) break;
  }
  return true;
}

// Settings edits and presence renewals advance storage without changing card choices.
// A move or substitution ends the contiguous window of playable revisions.
function firstPlayableRevision(row) {
  const change = row.state.lastTurnPreservingChange ?? row.state.lastPaceChange;
  return change?.revision === row.revision ? change.from : row.revision;
}

function preserveTurn(row) {
  row.state.lastTurnPreservingChange = {from:firstPlayableRevision(row), revision:row.revision + 1};
}

async function changeTableSetting(row, input, save, now) {
  const changingClock = input.op === 'auto-play' || input.op === 'room-auto-play';
  if (changingClock) check(typeof input.autoPlay === 'boolean', '10초 자동진행 설정을 확인해 주세요.');
  else check(input.pace === normalizeGameSpeed(input.pace), '테이블 진행 속도를 확인해 주세요.');
  for (let retry = 0; ; retry++) {
    const state = row.state;
    check(!state.round.result, '이 판은 이미 끝났습니다.', 409);
    const previousPace = normalizeGameSpeed(state.pace);
    if (changingClock ? (state.autoPlay !== false) === input.autoPlay : previousPace === input.pace) return row;
    check(retry < 4, '차례가 바뀌었습니다. 설정을 다시 선택해 주세요.', 409);
    if (changingClock) {
      const timed = usesTurnClock(state);
      state.autoPlay = input.autoPlay;
      if (usesTurnClock(state) !== timed) scheduleTurn(state, now);
    } else {
      if (state.bots[state.round.turn] && state.dueAt > now) {
        const remaining = state.dueAt - now;
        state.dueAt = now + Math.round(remaining * paceMultiplier(input.pace) / paceMultiplier(previousPace));
      }
      state.pace = input.pace;
    }
    preserveTurn(row);
    row = (await save(row)).hand;
  }
}

async function controlHand(input, id, db, hand, now, show) {
  const legacy = input.op === 'pace' || input.op === 'auto-play';
  if (!legacy) check(typeof input.credential === 'string' && /^[0-9a-f]{64}$/.test(input.credential) &&
    Number.isSafeInteger(input.term) && input.term>0, '방장 권한을 확인해 주세요.', 403);
  const proof = {legacy, id, credential:legacy ? null : input.credential, term:legacy ? null : input.term};
  const save = row => db.control(hand, proof, row);
  let context = await db.control(hand, proof);
  check(context?.hand, '해당 판을 찾을 수 없습니다.', 404);
  if (input.op !== 'room-takeover') {
    const row = await changeTableSetting(context.hand, input, save, now);
    const receipt = await show(row, legacy ? id : null);
    return legacy ? receipt : {...receipt, publicGame:receipt.game};
  }
  for (let retry = 0; !context.hand.state.round.result; retry++) {
    const {hand:row, departedSeats} = context;
    // The database derives this list from the authorized host changes since
    // the deal. A client cannot nominate someone else's seat for substitution.
    const leaving = departedSeats.filter(seat => row.seats[seat] && !row.state.bots[seat]);
    if (!leaving.length) break;
    check(retry < 4, '차례가 바뀌었습니다. 다시 시도해 주세요.', 409);
    const timed = usesTurnClock(row.state);
    for (const seat of leaving) replaceSeat(row.state, seat);
    if (leaving.includes(row.state.round.turn) || (timed && !usesTurnClock(row.state))) scheduleTurn(row.state, now);
    context = await save(row);
  }
  const receipt = await show(context.hand, null);
  return {...receipt, publicGame:receipt.game};
}

// All persistence goes through trusted, transactional RPCs. The original
// account roster is immutable even after a seat's bot flag changes.
export async function operateHand(input, accountId, db, now = Date.now(), playback) {
  check(input && typeof input === 'object' && !Array.isArray(input), '요청을 확인해 주세요.');
  const {op} = input;
  const roomControl = op === 'room-takeover' || op === 'room-pace' || op === 'room-auto-play';
  check(roomControl || ['ready','start','active','view','act','leave','pace','auto-play','watch','tick'].includes(op), '지원하지 않는 요청입니다.');
  const publicRead = op === 'watch' || op === 'tick';
  const id = accountId?.toLowerCase() ?? null;
  if (!roomControl && !publicRead) check(uuid(id), '이메일 인증 후 로그인해 주세요.', 401);
  if (op === 'active') return {handId:await db.active()};
  check(uuid(input.handId), '판 번호가 올바르지 않습니다.');
  const hand = input.handId.toLowerCase();
  function show(row, viewer) {
    const receipt = present(row, viewer, now);
    return playback ? playback(receipt, row.state.round, input.playCursor) : receipt;
  }
  if (roomControl || op === 'pace' || op === 'auto-play') return controlHand(input, id, db, hand, now, show);
  if (op === 'ready' || op === 'start') {
    const spec = manifestOf(input);
    const hash = await hashManifest(spec);
    const seat = spec.seats.indexOf(id);
    if (op === 'ready') {
      check(seat >= 0 || id === spec.host, '이 판의 참가 명단을 확인해 주세요.', 403);
      await db.ready(hand, spec.room, seat, hash);
      return {ready:true, seat};
    }
    check(id === spec.host, '방장만 판을 시작할 수 있습니다.', 403);
    return show(await startHand(db, hand, spec, hash, now), id);
  }

  let row = await db.read(hand);
  check(row, '해당 판을 찾을 수 없습니다.', 404);
  const seat = id ? row.seats.indexOf(id) : -1;
  if (!publicRead) check(seat >= 0 || row.host === id, '이 판의 참가 계정을 확인해 주세요.', 403);
  const state = row.state;
  let changed = false;
  if (op === 'leave') {
    // A concurrent move may win the first CAS. Retry a voluntary departure
    // until the database reports that this specific seat has a substitute.
    check(seat >= 0, '참가한 자리에서만 나갈 수 있습니다.', 403);
    for (let retry = 0; !row.state.round.result; retry++) {
      const s = row.state;
      const finish = input.finishIfAlone === true && !s.finishUnattended &&
        s.bots.every((bot, index) => bot || index === seat);
      if (s.bots[seat] && !finish) break;
      check(retry < 4, '차례가 바뀌었습니다. 다시 시도해 주세요.', 409);
      if (!s.bots[seat]) {
        const wasTimed = usesTurnClock(s);
        replaceSeat(s, seat);
        if (s.round.turn === seat || (wasTimed && !usesTurnClock(s))) scheduleTurn(s, now);
      }
      if (finish) {
        s.finishUnattended = true;
        s.dueAt = now;
      }
      row = await db.save(row);
    }
    if (row.state.finishUnattended) changed = advanceDue(row, now, true);
  } else if (op === 'act') {
    check(seat >= 0 && !state.bots[seat], '현재 이 자리에서 카드를 낼 수 없습니다.', 403);
    check(Number.isSafeInteger(input.revision), '판의 버전을 확인해 주세요.');
    for (let retry = 0; !row.state.round.result &&
         input.revision >= firstPlayableRevision(row) && input.revision <= row.revision; retry++) {
      check(retry < 4, '설정이 변경되고 있습니다. 잠시 후 카드를 다시 내 주세요.', 409);
      check(!row.state.bots[seat] && row.state.round.turn === seat, '지금은 내 차례가 아닙니다.');
      const deadline = turnDeadline(row.state);
      if (deadline !== null && now >= deadline) advanceDue(row, now, false);
      else move(row, input.action, now);
      row = await db.save(row);
    }
  } else if (op === 'view' && !state.round.result && state.round.turn === seat &&
             !state.bots[seat] && !usesTurnClock(state) && state.dueAt - now <= 45_000) {
    // An authenticated read renews the active seat's presence while thinking.
    state.dueAt = now + RECONNECT_MS;
    preserveTurn(row);
    changed = true;
  } else changed = advanceDue(row, now, op === 'tick');
  if (changed) row = await db.save(row);
  if (op === 'tick') return {handId:hand, revision:row.revision, settled:row.settled};
  return show(row, publicRead ? null : id);
}
