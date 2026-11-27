import {HostSession} from '../../../session.js';
import {normalizeGameSpeed} from '../../../table-timing.js';
import {beginOffer, acknowledgeOffer, advanceDeals, offerFor, controlNext} from './deals.js';

const LEASE_MS = 120_000;
const HEARTBEAT_MS = 20_000;
const CHAT_LIMIT = 60;
const MEMBER_LIMIT = 48;
const UNSIGNED_MEMBER_LIMIT = MEMBER_LIMIT - 5;
const operations = new Set(['join','poll','leave','seat','watch','reserve','depart','settings','swap',
  'swap-answer','swap-cancel','chat','start','ready','next','lobby']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const check = (ok,message,status=400,code) => {
  if (!ok) throw Object.assign(new Error(message), {status,code});
};
const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2,'0')).join('');
const identity = async credential => hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(credential))));
const hostAccount = state => state.members[state.host]?.accountId ?? null;
const sessionId = (state,actor) => actor === state.host ? null : actor;
const actorSeat = (state,session,actor) => state.host === actor ? session.hostSeat : session.seatFor(actor);
const live = session => Boolean(session.chipHandId && session.round && !session.round.result);

// Postgres jsonb reorders object keys. A read-only poll must not acquire
// the slot's write lock merely because JS restored a different key order.
function sameJson(a,b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b,k) && sameJson(a[k],b[k]));
}

function validate(input) {
  check(input && operations.has(input.op) && Number.isInteger(input.slot) && input.slot >= 1 && input.slot <= 4,
    '공개 테이블과 요청을 확인해 주세요.');
  check(typeof input.credential === 'string' && /^[a-f0-9]{64}$/.test(input.credential),'입장 정보를 다시 확인해 주세요.');
  if (input.op !== 'join') check(uuid(input.roomId),'테이블 입장 정보를 확인해 주세요.');
  if (!['poll','join'].includes(input.op)) check(uuid(input.requestId),'요청 번호를 확인해 주세요.');
  if (input.after != null) check(Number.isSafeInteger(input.after) && input.after >= 0,'채팅 위치를 확인해 주세요.');
  if (input.op === 'join') check(typeof input.name === 'string' && input.name.trim() && input.name.trim().length <= 16,
    '닉네임은 1~16자로 입력해 주세요.');
}

function newMember(accountId,name,now,seq) {
  return {accountId,name:name.trim(),seenAt:now,joinedAt:now,joinSeq:seq,receipts:[]};
}

function open(input,actor,accountId,now) {
  check(accountId,'빈 공개 테이블을 열려면 로그인해 주세요.',401);
  const p = input.preferences ?? {};
  const name = input.name.trim();
  const session = new HostSession(name,p.rules,undefined,p.roundLimit === undefined ? 10 : p.roundLimit,
    {publicRoom:true,hostSpectator:true,pace:p.pace,modelChoice:p.modelChoice ?? 'random'});
  const state = {slot:input.slot,roomCode:'PUB00'+input.slot,owner:accountId,host:actor,
    controlKey:hex(crypto.getRandomValues(new Uint8Array(32))),controlTerm:1,
    members:{[actor]:newMember(accountId,name,now,0)},chat:[],chatSeq:0,effects:[],offer:null,nextRound:null};
  return {state,session};
}

function join(state,session,actor,accountId,name,now) {
  if (state.members[actor]) {
    state.members[actor].joinSeq = state.chatSeq;
    return session;
  }
  const members = Object.values(state.members);
  check(members.length < MEMBER_LIMIT &&
    (accountId || members.filter(m => !m.accountId).length < UNSIGNED_MEMBER_LIMIT),'관전석이 모두 찼습니다.',409);
  const previous = state.host, previousAccount = hostAccount(state);
  const error = session.addGuest(actor,name,'watch');
  check(!error,error);
  state.members[actor] = newMember(accountId,name,now,state.chatSeq);
  // When only an unsigned observer remained, the first signed-in visitor
  // can start deals. Keep the former observer connected after transferring.
  if (!previous || (!previousAccount && accountId)) {
    session = HostSession.takeOver(session.handoffState(),actor);
    if (previous) session.addGuest(previous,state.members[previous].name,'watch');
    state.host = actor;
    if (previousAccount !== accountId) state.controlTerm++;
  }
  return session;
}

function cancelOffer(state) {
  if (!state.offer) return;
  check(state.offer.status !== 'starting','판이 시작되고 있습니다. 잠시 후 다시 시도해 주세요.',409);
  state.offer = null;
  state.dealNotice = '참가 정보가 바뀌어 판 준비를 취소했습니다.';
  if (state.nextRound) state.nextRound = {...state.nextRound,status:'manual',deadline:null,remainingMs:0};
}

function enqueueLeave(state,session,actor) {
  const accountId = state.members[actor].accountId;
  if (accountId && live(session) && actorSeat(state,session,actor) >= 0)
    state.effects.push({op:'leave',handId:session.chipHandId,accountId});
}

function remove(state,session,actor) {
  const id = sessionId(state,actor);
  if (actor === state.host || session.hasSeatOrReservation(id)) cancelOffer(state);
  enqueueLeave(state,session,actor);
  const priorAccount = hostAccount(state);
  delete state.members[actor];
  if (actor !== state.host) {
    session.removeGuest(actor);
    return session;
  }
  const remaining = Object.keys(state.members).sort((a,b) =>
    Number(Boolean(state.members[b].accountId)) - Number(Boolean(state.members[a].accountId)) ||
    state.members[a].joinedAt - state.members[b].joinedAt || a.localeCompare(b));
  state.host = remaining[0] ?? null;
  if (priorAccount !== hostAccount(state)) state.controlTerm++;
  if (state.host) return HostSession.takeOver(session.handoffState(),state.host);
  session.sitOut(null);
  if (live(session)) {
    // Spectators should see AI turns at table pace. Only the last departure
    // asks the engine to finish unattended, including a last spectator who
    // was never a participant in the financial hand.
    const last = state.effects.findLast(e => e.op === 'leave' && e.handId === session.chipHandId);
    if (last) last.finishIfAlone = true;
    else if (state.finishAccount) state.effects.push({op:'leave',handId:session.chipHandId,
      accountId:state.finishAccount,finishIfAlone:true});
  }
  state.nextRound = null;
  return session;
}

function publicResult(state,session,actor,input,roomId,version,now) {
  const member = state.members[actor];
  if (!member) return {left:true,roomId,version,serverNow:now};
  const isHost = state.host === actor;
  const view = isHost ? session.hostView() : session.viewFor(actor);
  // Cached clients compare the advertised clock with a pending pre-update offer.
  if (state.offer?.status === 'pending' && state.offer.spec.autoPlay === false) view.autoPlay = false;
  const floor = input.op === 'join' ? state.chatSeq : Math.max(member.joinSeq,input.after ?? state.chatSeq);
  const messages = state.chat.filter(m => m.seq > floor).map(({author,...m}) => ({...m,own:author === actor}));
  return {roomId,version,serverNow:now,isHost,
    view:{...view,isHost,departing:session.isDeparting(sessionId(state,actor)),nextRound:state.nextRound,dealNotice:state.dealNotice ?? null},
    messages,cursor:state.chatSeq,offer:member.accountId ? offerFor(state,member.accountId) : null};
}

async function act(state,session,actor,input,api,now) {
  const member = state.members[actor], id = sessionId(state,actor);
  const {op,wanted,revision} = input;
  const hostOnly = ['settings','start','next','lobby'].includes(op);
  if (hostOnly) check(state.host === actor,'방장만 테이블을 설정할 수 있습니다.',403);
  if ((op === 'seat' || (op === 'reserve' && wanted === true)) && !session.hasSeatOrReservation(id)) {
    check(member.accountId,'이메일 인증 후 로그인해 주세요.',401);
    for (const [other,entry] of Object.entries(state.members)) {
      check(other === actor || entry.accountId !== member.accountId || !session.hasSeatOrReservation(sessionId(state,other)),
        '같은 계정이 이미 이 테이블에서 참가하고 있습니다.',409);
    }
    await api.canPlay();
  }
  const priorPlan = state.offer ? session.plannedTable() : null;
  let message;
  switch (op) {
    case 'join': case 'poll': break;
    case 'seat':
      if (actorSeat(state,session,actor) < 0) session.takeOpenSeat(id,input.target,revision);
      else session.moveSeat(id,input.target,revision);
      break;
    case 'swap': session.requestSeatSwap(id,input.target,revision); break;
    case 'swap-answer': session.answerSeatSwap(id,input.accepted,revision); break;
    case 'swap-cancel': session.cancelSeatSwap(id,revision); break;
    case 'reserve': session.setReservation(id,wanted); break;
    case 'watch':
      if (session.hasSeatOrReservation(id)) cancelOffer(state);
      enqueueLeave(state,session,actor);
      session.sitOut(id);
      break;
    case 'depart':
      check(session.setGuestDeparture(id,input.handId,wanted),'이번 판의 나가기 예약을 확인해 주세요.',409);
      break;
    case 'leave': session = remove(state,session,actor); break;
    case 'settings': {
      const {key,value} = input;
      if (key === 'rules') session.setRules(value);
      else if (key === 'roundLimit') session.setRoundLimit(value);
      else if (key === 'modelChoice') session.setModelChoice(value);
      else if (key === 'autoPlay') break; // Obsolete requests from cached hosts.
      else if (key === 'pace') {
        check(normalizeGameSpeed(value) === value,'진행 속도를 확인해 주세요.');
        session.setPace(value);
      } else check(false,'테이블 설정을 확인해 주세요.');
      if (live(session) && key === 'pace')
        state.effects.push({op:'setting',id:input.requestId,handId:session.chipHandId,key,value});
      break;
    }
    case 'chat': {
      const text = typeof input.text === 'string' && input.text.trim();
      check(text && text.length <= 280,'메시지는 1~280자로 입력해 주세요.');
      check(now - (member.lastChat ?? -Infinity) >= 400 && now - (state.chat.at(-15)?.time ?? -Infinity) >= 5000,
        '잠시 후 메시지를 보내 주세요.',429);
      member.lastChat = now;
      const seq = ++state.chatSeq;
      message = {seq,requestId:input.requestId,seat:actorSeat(state,session,actor),name:member.name,text,time:now};
      state.chat.push({...message,id:seq,author:actor});
      state.chat = state.chat.slice(-CHAT_LIMIT);
      break;
    }
    case 'start': await beginOffer(state,session,now); break;
    case 'ready': await acknowledgeOffer(state,session,member.accountId,input.handId,input.accepted,now); break;
    case 'next': await controlNext(state,session,wanted === true ? 'resume' : wanted === false ? 'pause' : wanted,now); break;
    case 'lobby':
      session.returnToRoom();
      state.nextRound = null;
      break;
  }
  if (priorPlan && state.offer && !['start','ready','next','poll','join','chat','leave'].includes(op) &&
      (op === 'lobby' || !sameJson(priorPlan,session.plannedTable()))) cancelOffer(state);
  return {session,message};
}

// Effects are durable before touching chip ownership. Two concurrent readers
// can repeat the same effect; the chip engine applies it to the same hand.
async function drain(state,chips,roomId) {
  for (const effect of state.effects) {
    if (effect.op === 'leave') await chips.leave(effect.handId,effect.accountId,effect.finishIfAlone === true);
    else if (effect.key === 'pace') {
      try {
        await chips.setting(effect.handId,{roomId,effectId:effect.id,controlKey:state.controlKey,controlTerm:state.controlTerm,
          controllerId:hostAccount(state)},effect.key,effect.value);
      } catch (error) {
        if (error.code === 'stale_lobby_effect' || error.status === 410) continue;
        if (![400,403,404,409].includes(error.status)) throw error;
        const receipt = await chips.read(effect.handId);
        if (receipt && !receipt.publicGame.result) throw error;
      }
    }
  }
  state.effects = [];
}

export async function operateLobby(input,accountId,api,clock = Date.now) {
  validate(input);
  const actor = await identity(input.credential);
  for (let trial = 0; trial < 12; trial++) {
    const now = clock();
    const row = await api.read(input.slot);
    if (row.legacy) {
      check(false,'이 테이블은 기존 대국이 끝나면 서버 대기실로 전환됩니다.',409,'LEGACY_PUBLIC_ROOM');
    }
    if (input.op === 'leave' && (!row.state || row.roomId !== input.roomId))
      return {left:true,roomId:input.roomId,version:row.revision,serverNow:now};
    if (input.op !== 'join') check(row.roomId === input.roomId && row.state,'테이블이 새로 열렸습니다. 다시 입장해 주세요.',410,'LOBBY_ROOM_CHANGED');

    const original = row.state;
    const priorHost = original ? hostAccount(original) : null;
    const originalOffer = original?.offer?.spec?.handId;
    const roomId = row.roomId ?? crypto.randomUUID();
    let state, session;
    if (original) {
      state = structuredClone(original);
      session = HostSession.restore(state.session);
    } else ({state,session} = open(input,actor,accountId,now));

    const member = state.members[actor];
    if (member) check(member.accountId === accountId,'입장에 사용한 계정으로 다시 로그인해 주세요.',403);
    if (input.op !== 'join' && input.op !== 'leave') {
      check(member && now - member.seenAt < LEASE_MS,'입장 시간이 만료되었습니다. 테이블에 다시 입장해 주세요.',410,'LOBBY_MEMBERSHIP_EXPIRED');
    }
    // Apply already committed effects/intent before another member changes a
    // seat. A failed write can safely retry these operations after a CAS miss.
    const maintenance = Boolean(state.effects.length || state.offer?.status === 'starting');
    if (state.effects.length) await drain(state,api.chips,roomId);
    const starting = state.offer?.status === 'starting' ? state.offer.spec : null;
    const alreadySynced = !maintenance && Number.isInteger(row.chipRevision) && row.chipRevision === state.session?.chipRevision;
    const chips = alreadySynced ? {...api.chips,read:async () => null} : api.chips;
    await advanceDeals(state,session,chips,now);
    if (starting && session.chipHandId === starting.handId) state.finishAccount = starting.seats.find(Boolean);
    if (state.offer?.status !== 'starting') {
      const expired = Object.keys(state.members).filter(key => now - state.members[key].seenAt >= LEASE_MS);
      for (const key of expired) session = remove(state,session,key);
    }
    let message;
    // Release an abandoned edition before creating the next one. This also
    // gives the new room its own chat archive and distinct room UUID.
    const abandoned = original && !Object.keys(state.members).length && !live(session) && !state.effects.length;
    if (!maintenance && !abandoned) {
      if (input.op === 'join') session = join(state,session,actor,accountId,input.name,now);
      const current = state.members[actor];
      if (current && now - current.seenAt >= HEARTBEAT_MS) current.seenAt = now;
      if (current && !current.receipts.includes(input.requestId)) {
        ({session,message} = await act(state,session,actor,input,api,now));
        if (input.requestId && !['join','poll'].includes(input.op) && state.members[actor]) {
          current.receipts.push(input.requestId);
          current.receipts = current.receipts.slice(-20);
        }
      }
    }
    if (original) state.controlTerm = original.controlTerm + Number(priorHost !== hostAccount(state));
    state.session = session.handoffState();
    const close = !Object.keys(state.members).length && !live(session) && !state.effects.length;
    let version = row.revision;
    if (close || !sameJson(state,original)) {
      const hand = state.offer?.spec;
      const commit = await api.commit({p_slot:input.slot,p_revision:row.revision,p_room_id:roomId,p_state:close ? null : state,
        p_summary:session.publicSummary(),p_owner:state.owner,p_controller:hostAccount(state),p_message:message ?? null,
        p_hand:hand && hand.handId !== originalOffer ? {id:hand.handId,hostId:hand.host} : null});
      if (!commit.applied) continue;
      version = commit.revision;
    }
    if ((abandoned && input.op === 'join') || maintenance || state.effects.length || state.offer?.status === 'starting') continue;
    return publicResult(state,session,actor,input,roomId,version,now);
  }
  throw Object.assign(new Error('테이블이 변경되고 있습니다. 잠시 후 다시 시도해 주세요.'),{status:409});
}
