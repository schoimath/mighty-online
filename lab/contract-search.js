import {applyAction, baselinePlay, botDecision, DECK, getView, mighty, pointsIn, sortHand} from '../engine.js';
import {selectDiscard} from '../bot-exchange.js';
import {settlements} from '../table-scoring.js?v=1.1.20261127195129';
import {protectPartner} from './partnership-policy.js';
import {searchAction} from './search-policy.js';

// Immediately after picking up the kitty the declarer knows all 13 of these
// cards. Sample the four original ten-card hands conditional on the live
// zero-point misdeal rule. Public bid strength is not fitted by this sampler.
function opposingHands(view, rng) {
  const rest = DECK.filter(card => !view.hand.includes(card));
  for (let attempt = 0; attempt < 64; attempt++) {
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    let cursor = 0;
    const hands = Array.from({length:5}, (_, seat) => {
      if (seat === view.seat) return view.hand;
      const hand = sortHand(rest.slice(cursor, cursor + 10));
      cursor += 10;
      return hand;
    });
    if (hands.every(hand => pointsIn(hand) > 0)) return hands;
  }
  return null;
}

function playContract(view, hands, discard) {
  const round = {phase:'discard', rules:view.rules, turn:view.seat, declarer:view.seat,
    hands:[...hands], bid:view.bid, bidHistory:view.bidHistory, discarded:[], friendKnown:false, friend:null,
    trick:[], trickNo:1, lastTrick:null, scores:[0,0,0,0,0], captured:Array.from({length:5}, () => [])};
  applyAction(round, view.seat, discard);
  applyAction(round, view.seat, botDecision(getView(round, view.seat)));
  while (!round.result) {
    const actor = getView(round, round.turn);
    const move = actor.choices.plays.length === 1 ? actor.choices.plays[0] : baselinePlay(actor);
    applyAction(round, round.turn, {type:'play', ...move});
  }
  return round.result;
}

export function contractSearchAction(view, rng = Math.random) {
  if (view.phase !== 'discard') return searchAction(protectPartner(view));
  const original = view.bid;
  const candidates = view.choices.contracts.filter(({suit}) => suit === original.suit || suit === 'N'
    || view.hand.filter(card => card[0] === suit).length >= 4);
  const plans = new Map();
  for (const contract of candidates) {
    if (!plans.has(contract.suit)) {
      const cards = selectDiscard(view.hand, contract.suit, mighty(contract.suit));
      plans.set(contract.suit, {type:'discard', cards, contract});
    }
  }
  const fallback = plans.get(original.suit);
  if (candidates.length === 1) return fallback;
  const gains = candidates.map(() => ({sum:0, squares:0}));
  let samples = 0;
  for (let draw = 0; draw < 24; draw++) {
    const hands = opposingHands(view, rng);
    if (!hands) continue;
    const results = new Map();
    for (const [suit, plan] of plans) results.set(suit, playContract(view, hands, plan));
    const baseline = settlements(results.get(original.suit), original.suit, view.scoringVersion)[view.seat];
    for (const [i, contract] of candidates.entries()) {
      // The frozen follow-up policy makes exactly the same plays for different
      // target points in the same suit. Only the terminal settlement changes.
      const result = results.get(contract.suit);
      const outcome = {...result, target:contract.points, won:result.points >= contract.points};
      const gain = settlements(outcome, contract.suit, view.scoringVersion)[view.seat] - baseline;
      gains[i].sum += gain;
      gains[i].squares += gain * gain;
    }
    samples++;
  }
  if (samples < 2) return fallback;
  let best = original, bestGain = 0;
  for (const [i, {sum, squares}] of gains.entries()) {
    const mean = sum / samples;
    const se = Math.sqrt(Math.max(0, squares / samples - mean * mean) / (samples - 1));
    if (mean - se > bestGain) {
      bestGain = mean - se;
      best = candidates[i];
    }
  }
  return {...plans.get(best.suit), contract:{points:best.points, suit:best.suit}};
}
