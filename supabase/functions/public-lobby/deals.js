import {chipManifest} from '../../../chip-play.js';
import {chipManifestDigest} from '../chip-hand/hand.js';

const CONSENT_MS = 30_000;
const NEXT_ROUND_MS = 10_000;

function participants(spec) {
  return [...new Set([spec.host, ...spec.seats.filter(Boolean)])];
}

export function beginOffer(state, session, now) {
  if (state.offer) return;
  const accounts = new Map(Object.entries(state.members).map(([key, member]) =>
    [key === state.host ? null : key, member.accountId]));
  const plan = session.plannedTable();
  if (plan.seats.some(seat => !seat.bot && !accounts.get(seat.id))) {
    throw new Error('자리에 앉은 참가자 모두 로그인해야 대국을 시작할 수 있습니다.');
  }
  const spec = chipManifest(plan, state.roomCode, accounts.get(null), accounts);
  state.offer = {spec, ready:[], status:'pending', expiresAt:now + CONSENT_MS};
  state.dealNotice = null;
  if (session.round?.phase === 'result') {
    state.nextRound = {key:session.chipHandId, status:'starting', deadline:null, remainingMs:0};
  }
}

export function offerFor(state, accountId) {
  const offer = state.offer;
  if (offer?.status !== 'pending' || offer.ready.includes(accountId)) return null;
  return participants(offer.spec).includes(accountId) ? offer.spec : null;
}

function cancelOffer(state, message) {
  state.offer = null;
  state.dealNotice = message;
  if (state.nextRound) state.nextRound = {...state.nextRound, status:'manual', deadline:null, remainingMs:0};
}

export async function acknowledgeOffer(state, session, accountId, handId, accepted, now) {
  const offer = state.offer;
  if (!offer || offer.spec.handId !== handId || !participants(offer.spec).includes(accountId)) {
    throw new Error('현재 판의 참가 명단을 확인해 주세요.');
  }
  if (typeof accepted !== 'boolean') throw new Error('참가 여부를 확인해 주세요.');
  if (offer.status === 'starting' || offer.ready.includes(accountId)) return;
  if (now >= offer.expiresAt) return cancelOffer(state, '참가 확인 시간이 지났습니다. 다시 시작해 주세요.');
  if (!accepted) return cancelOffer(state, '참가 확인을 마치지 못했습니다. 자리를 확인하고 다시 시작해 주세요.');
  offer.ready.push(accountId);
  if (participants(offer.spec).every(id => offer.ready.includes(id))) {
    offer.manifest = await chipManifestDigest(offer.spec);
    offer.status = 'starting';
  }
}

export function controlNext(state, session, wanted, now) {
  const timer = state.nextRound;
  if (session.round?.phase !== 'result' || !timer || timer.key !== session.chipHandId) {
    throw new Error('다음 판을 진행할 수 있는지 확인해 주세요.');
  }
  if (wanted === 'now') return beginOffer(state, session, now);
  if (wanted === 'pause' && timer.status === 'running') {
    state.nextRound = {...timer, status:'paused', remainingMs:Math.max(0, timer.deadline - now), deadline:null};
  } else if (wanted === 'resume' && timer.status === 'paused') {
    state.nextRound = {...timer, status:'running', deadline:now + timer.remainingMs};
  }
}

export async function advanceDeals(state, session, chips, now) {
  const offer = state.offer;
  if (offer?.status === 'starting') {
    let receipt;
    try { receipt = await chips.start(offer.spec); }
    catch (error) {
      // Transient or ambiguous failure: keep the same committed intent. The
      // start RPC returns the original deal if another poll already started it.
      if (![400,403,409].includes(error.status)) throw error;
      cancelOffer(state, error.message);
      return;
    }
    session.startChipHand(receipt);
    state.offer = null;
    state.nextRound = null;
  } else if (offer && now >= offer.expiresAt) {
    cancelOffer(state, '참가 확인 시간이 지났습니다. 다시 시작해 주세요.');
  }
  if (!session.chipHandId) return;
  if (session.round?.phase !== 'result' && offer?.status !== 'starting') {
    const receipt = await chips.read(session.chipHandId);
    if (receipt) session.syncChipHand(receipt);
  }
  if (session.round?.phase !== 'result' || session.hostView().scoreboard.complete) return;
  if (!state.nextRound || state.nextRound.key !== session.chipHandId) {
    state.nextRound = {key:session.chipHandId, status:'running', deadline:now + NEXT_ROUND_MS, remainingMs:NEXT_ROUND_MS};
  } else if (!state.offer && state.nextRound.status === 'running' && now >= state.nextRound.deadline) {
    try { beginOffer(state, session, now); }
    catch (error) { cancelOffer(state, error.message); }
  }
}
