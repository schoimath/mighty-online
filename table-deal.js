import {applyAction as applyEngineAction, createGame as deal, getView as project, pointsIn} from './engine.js';
import {canDeclareSetting, finishSettingFriendTrick} from './table-setting.js';

export {canDeclareSetting, resolveSetting} from './table-setting.js';

// Limit retries if a faulty random source repeatedly returns an unusable deal
// or a value rejected by the engine's unbiased shuffle.
function dealRandom(random) {
  let draws = 0;
  const sample = new Uint32Array(1);
  return () => {
    if (++draws > 4096) throw new Error('카드를 섞지 못했습니다. 다시 시도해 주세요.');
    const value = random ? random() : crypto.getRandomValues(sample)[0] / 2 ** 32;
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('카드 배분 난수가 올바르지 않습니다.');
    return value;
  };
}

function checkOpeningHands(state, random) {
  const {dealNo, firstSeat, rules} = state;
  let misdealCount = 0;
  while (state.hands.some(hand => pointsIn(hand) === 0)) {
    misdealCount++;
    state = deal({firstSeat, rules, random});
  }
  return Object.assign(state, {dealNo, misdealCount});
}

export function createGame(options = {}) {
  const random = dealRandom(options.random);
  return checkOpeningHands(deal({...options, random}), random);
}

export function applyAction(state, seat, action, randomSource) {
  if (state.settingAwaitingFriend && state.trick.length === 4) {
    return finishSettingFriendTrick(state, seat, action);
  }
  if (state.phase !== 'bid' || state.bid || action?.type !== 'pass') {
    return applyEngineAction(state, seat, action);
  }
  // Validate the replacement before committing the fifth pass, so a failed
  // shuffle leaves the host's round and revision available for a retry.
  const next = {...state, passed: [...state.passed], bidHistory: [...state.bidHistory]};
  const random = dealRandom(randomSource);
  applyEngineAction(next, seat, action, random);
  return Object.assign(state, next.dealNo !== state.dealNo ? checkOpeningHands(next, random) : next);
}

export function getView(state, seat) {
  return withTableRules(state, project(state, seat));
}

export function getSpectatorView(state) {
  // Reuse the table's public masking of captured piles, the friend and the
  // most recent trick. New fields on player projections stay private until
  // explicitly included here. An inactive seat has no possible moves.
  const inactive = state.turn === 0 ? 1 : 0;
  const {phase, turn, dealNo, rules, counts, passed, bid, bidHistory, declarer, friendKnown, friend,
    call, trick, trickNo, lastTrick, result, scores, captured, choices} = project(state, inactive);
  return withTableRules(state, {seat:-1, selfRole:'spectator', hand:[], discarded:[], choices,
    phase, turn, dealNo, rules, counts, passed, bid, bidHistory, declarer, friendKnown, friend,
    call, trick, trickNo, lastTrick, result, scores, captured});
}

function withTableRules(state, view) {
  if (state.phase === 'play' || state.result?.setting) {
    view.choices.canDeclareSetting = canDeclareSetting(state, view.seat);
    view.settingAwaitingFriend = Boolean(state.settingAwaitingFriend);
  }
  if (state.result?.setting?.success === false) {
    view.settingPenaltyCards = state.settingOppositionPile.slice();
  }
  return {...view, misdealCount: state.misdealCount ?? 0};
}
