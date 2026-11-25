import {botObservation, DEFAULT_RULES} from '../engine.js';
import {applyAction, createGame} from '../table-deal.js';
import {settlements} from '../table-scoring.js';
import {rngFor} from './game.js';

export function liveOutcomes(state) {
  if (!state.result) throw new Error('Terminal returns require a finished game.');
  const {won, declarer, friend} = state.result;
  return settlements(state.result, state.bid.suit).map((settlement, seat) => {
    const attacker = seat === declarer || seat === friend;
    const role = seat === declarer ? (friend == null ? 'solo' : 'declarer')
      : seat === friend ? 'friend' : 'opposition';
    return {win: Number(attacker === won), settlement, role, captured: state.captured[seat].length};
  });
}

export function liveUtility(outcome, objective, {scoreScale = 640, alpha = .7} = {}) {
  if (!(Number.isFinite(scoreScale) && scoreScale > 0 && alpha >= 0 && alpha <= 1)) {
    throw new Error('Invalid terminal reward settings.');
  }
  const score = outcome.settlement / scoreScale;
  if (objective === 'win') return outcome.win;
  if (objective === 'score') return score;
  if (objective === 'balanced') return alpha * outcome.win + (1 - alpha) * score;
  throw new Error('Unknown terminal objective: ' + objective);
}

// Keep the large discard × revised-contract mask factored in observe().choices.
// Enumerate its exact Cartesian product only for callers requesting flat actions.
export function legalActionsFromObservation(view) {
  if (view.turn !== view.seat) return [];
  const {choices, hand} = view;
  switch (view.phase) {
    case 'bid': return [{type: 'pass'}, ...choices.bids.map(b => ({type: 'bid', ...b}))];
    case 'friend': return choices.friends.map(call => ({type: 'friend', ...call}));
    case 'play': return choices.plays.map(play => ({type: 'play', ...play}));
    case 'discard': {
      const actions = [];
      for (const contract of choices.contracts) {
        for (let i = 0; i < hand.length - 2; i++) {
          for (let j = i + 1; j < hand.length - 1; j++) {
            for (let k = j + 1; k < hand.length; k++) {
              actions.push({type: 'discard', contract, cards: [hand[i], hand[j], hand[k]]});
            }
          }
        }
      }
      return actions;
    }
    default: return [];
  }
}

export function createLiveEnv({seed, firstSeat = 0, rules = DEFAULT_RULES}) {
  let state, random, misdeals;
  function reset(options = {}) {
    seed = options.seed ?? seed;
    firstSeat = options.firstSeat ?? firstSeat;
    rules = options.rules ?? rules;
    random = rngFor(seed);
    state = createGame({random, firstSeat, rules});
    misdeals = state.misdealCount;
  }
  reset();
  return {
    reset,
    observe: seat => botObservation(state, seat),
    legalActions: seat => legalActionsFromObservation(botObservation(state, seat)),
    step(action) {
      const oldDeal = state.dealNo;
      applyAction(state, state.turn, action, random);
      if (state.dealNo !== oldDeal) misdeals += state.misdealCount;
    },
    terminalReturns: () => liveOutcomes(state),
    get turn() { return state.turn; },
    get done() { return state.result != null; },
    get dealNo() { return state.dealNo; },
    get misdealCount() { return misdeals; },
    get contract() { return state.bid && {...state.bid}; },
    get result() { return state.result && {...state.result}; }
  };
}

export function playLiveEpisode({seed, firstSeat = 0, policies, policySeeds, rules = DEFAULT_RULES,
  maxRedeals = 100, record = false}) {
  if (policies?.length !== 5 || !Array.from(policies).every(p => typeof p === 'function')) {
    throw new Error('Provide five episode-local seat policies.');
  }
  const seeds = policySeeds ?? policies.map((_, i) => (seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0);
  if (seeds.length !== 5) throw new Error('Five policy seeds required.');
  const random = seeds.map(rngFor);
  const env = createLiveEnv({seed, firstSeat, rules});
  const log = [];
  let actions = 0;
  while (!env.done) {
    if (env.dealNo - 1 > maxRedeals) throw new Error('Redeal limit exceeded for deal ' + seed);
    const seat = env.turn;
    const action = policies[seat](env.observe(seat), random[seat]);
    if (record) log.push({seat, action: structuredClone(action)});
    env.step(action);
    actions++;
  }
  const result = env.result;
  return {outcomes: env.terminalReturns(), contract: env.contract, actions, attackWon: result.won,
    attackPoints: result.points, redealCount: env.dealNo - 1, misdealCount: env.misdealCount,
    ...(record ? {log} : {})};
}
