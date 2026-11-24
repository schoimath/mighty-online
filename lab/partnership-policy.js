import {DECK, jokerActive, leadSuit, legalPlays, mighty, pointsIn, strength, winningPlay} from '../engine.js';
import {sampler} from '../bot-sampling.js';

export const PARTNERSHIP_POLICY_VERSION = 'protect-partner-v3';

function knownTeammate(view, seat) {
  if (view.selfRole === 'friend') return seat === view.declarer;
  if (!view.friendKnown) return false;
  if (view.selfRole === 'declarer') return seat === view.friend;
  return view.selfRole === 'opposition' && seat !== view.declarer && seat !== view.friend;
}

function partnerIsSafe(view, winner) {
  const {trick, bid} = view;
  const opponents = [];
  for (let offset = 1; offset < 5 - trick.length; offset++) {
    const seat = (view.seat + offset) % 5;
    if (!knownTeammate(view, seat)) opponents.push(seat);
  }
  if (!opponents.length || (winner.card === 'JK' && jokerActive(view))) return true;
  // An opening powerless Joker without a declared suit lets our play establish the lead.
  if (!leadSuit(trick)) return false;
  const active = jokerActive(view);
  const current = strength(winner.card, bid.suit, trick, active);
  const beatsPartner = card => strength(card, bid.suit, trick, active) > current;
  const seen = new Set([...view.hand, ...view.discarded, ...trick.map(p => p.card)]);
  for (const past of view.playedTricks ?? []) for (const p of past.cards) seen.add(p.card);
  if (!DECK.some(c => !seen.has(c) && beatsPartner(c))) return true;

  // Estimate the chance of a *legal* overtake by someone still to act. The sampler
  // uses the seat's own hand and public trick history, including demonstrated voids.
  const draw = sampler(view, view.playedTricks ?? [], DECK, mighty(bid.suit), hand => hand);
  if (!draw) return false;
  const trials = 20;
  // When several points are already exposed, protect them at a lower threat level.
  const points = pointsIn(trick.map(p => p.card));
  const tolerated = points >= 3 ? 2 : 5;
  let valid = 0, threatened = 0;
  for (let i = 0; i < trials; i++) {
    const sample = draw();
    if (!sample) continue;
    valid++;
    if (opponents.some(seat => legalPlays(view, sample.hands[seat]).some(p => beatsPartner(p.card)))) {
      if (++threatened > tolerated) return false;
    }
  }
  return valid >= trials / 2 && threatened / valid <= tolerated / trials;
}

export function protectPartner(view) {
  if (view.phase !== 'play' || !view.trick.length) return view;
  const master = mighty(view.bid.suit), options = view.choices.plays;
  if (!options.some(p => p.card === master) || !options.some(p => p.card !== master && p.card !== 'JK')) return view;
  const winner = winningPlay(view);
  if (!knownTeammate(view, winner.seat) || !partnerIsSafe(view, winner)) return view;
  const plays = options.filter(p => p.card !== master);
  return {...view, choices:{...view.choices, plays}};
}
