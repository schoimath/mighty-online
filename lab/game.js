import {applyAction, botObservation, createGame, DEFAULT_RULES} from '../engine.js';
import {outcomes} from './scoring.js';

// Mulberry32. Separate streams for deals and each seat keep counterfactuals aligned.
export function rngFor(seed) {
  if (!Number.isSafeInteger(seed)) throw new Error('Seed must be an integer.');
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let v = Math.imul(state ^ state >>> 15, state | 1);
    v ^= v + Math.imul(v ^ v >>> 7, v | 61);
    return ((v ^ v >>> 14) >>> 0) / 4294967296;
  };
}

export function playEpisode({seed, firstSeat = 0, policies, policySeeds, rules = DEFAULT_RULES,
  maxRedeals = 100, record = false}) {
  if (policies?.length !== 5 || policies.some(p => typeof p !== 'function')) throw new Error('Five seat policies required.');
  const dealRandom = rngFor(seed);
  const seats = policySeeds ?? policies.map((_, i) => (seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0);
  if (seats.length !== 5) throw new Error('Five independent seat RNG seeds required.');
  const seatRandom = seats.map(rngFor);
  const state = createGame({firstSeat, rules, random: dealRandom});
  const log = record ? [] : null;
  let actions = 0;
  while (!state.result) {
    if (state.dealNo - 1 > maxRedeals) throw new Error('Redeal limit exceeded for scenario ' + seed);
    const seat = state.turn;
    const action = policies[seat](botObservation(state, seat), seatRandom[seat]);
    if (record) log.push({seat, action: structuredClone(action)});
    applyAction(state, seat, action, dealRandom);
    actions++;
  }
  return {outcomes: outcomes(state), redealCount: state.dealNo - 1, contract: {...state.bid},
    attackWon: state.result.won, attackPoints: state.result.points, actions, ...(record ? {log} : {})};
}
