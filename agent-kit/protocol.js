import {withJokerStatus} from '../table-joker.js';

export const API_VERSION = 1;

export function turnRequest(view, seed) {
  const v = withJokerStatus(view);
  const self = v.seat === v.declarer;
  // Explicitly project game information. Account and transport metadata stay outside the API.
  const observation = {
    seat:v.seat, turn:v.turn, phase:v.phase, dealNo:v.dealNo, rules:v.rules,
    hand:v.hand, counts:v.counts, passed:v.passed, bid:v.bid,
    bidHistory:v.bidHistory.map(({seat, pass, suit, points}) => pass ? {seat, pass:true} : {seat, suit, points}),
    declarer:v.declarer, friendKnown:v.friendKnown, friend:v.friendKnown ? v.friend : null,
    call:v.call, selfRole:v.selfRole, trick:v.trick, trickNo:v.trickNo, lastTrick:v.lastTrick,
    playedTricks:v.playedTricks ?? [], jokerPlayed:v.jokerPlayed, scores:v.scores, captured:v.captured,
    knownKitty:self ? v.knownKitty ?? [] : [], discarded:self ? v.discarded : [], choices:v.choices,
  };
  return {apiVersion:API_VERSION, seed, observation:structuredClone(observation)};
}

const sameContract = (a, b) => a.suit === b.suit && a.points === b.points;

export function legalAction(view, action) {
  const {phase, choices} = view;
  if (view.seat !== view.turn || !action || typeof action !== 'object') return null;
  if (phase === 'bid' && action.type === 'pass' && choices.canPass) return {type:'pass'};
  if (phase === 'bid' && action.type === 'bid') {
    const bid = choices.bids.find(move => sameContract(move, action));
    if (bid) return {type:'bid', ...bid};
  }
  if (phase === 'friend' && action.type === 'friend') {
    const call = choices.friends.find(move => move.kind === action.kind && move.card === action.card);
    if (call) return {type:'friend', ...call};
  }
  if (phase === 'play' && action.type === 'play') {
    const play = choices.plays.find(move => move.card === action.card && move.suit === action.suit &&
      (move.jokerCall ?? false) === (action.jokerCall ?? false));
    if (play) return {type:'play', ...play};
  }
  if (phase === 'discard' && action.type === 'discard' && choices.discard) {
    const {cards, contract = view.bid} = action;
    const bid = contract && choices.contracts.find(move => sameContract(move, contract));
    if (bid && Array.isArray(cards) && cards.length === 3 && new Set(cards).size === 3 &&
        Array.from(cards).every(card => view.hand.includes(card))) {
      return {type:'discard', cards:[...cards], ...(action.contract === undefined ? {} : {contract:{...bid}})};
    }
  }
  return null;
}

export function checkAgent(agent) {
  if (agent?.apiVersion !== API_VERSION || typeof agent.id !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(agent.id) ||
      agent.id === 'random' || typeof agent.decide !== 'function' || typeof agent.label !== 'string' ||
      !agent.label.trim() || typeof agent.description !== 'string') {
    throw new Error('AI의 apiVersion, id, label, description, decide를 확인하세요.');
  }
  return agent;
}

export function runAgent(agent, view, seed) {
  const visible = withJokerStatus(view);
  const proposal = agent.decide(turnRequest(visible, seed));
  if (typeof proposal?.then === 'function') {
    Promise.resolve(proposal).catch(() => {});
    throw new Error('AI는 이번 수를 동기적으로 반환해야 합니다.');
  }
  const action = legalAction(visible, proposal);
  if (!action) throw new Error(`${agent.id} 모델이 ${view.phase} 단계에서 유효한 수를 반환하지 않았습니다.`);
  return action;
}
