import {baselinePlay, botDecision, mighty, policyPlay} from '../engine.js';

function sample(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

function randomAction(view, rng) {
  const {choices, phase} = view;
  if (phase === 'bid') {
    const index = Math.floor(rng() * (choices.bids.length + 1));
    return index === 0 ? {type: 'pass'} : {type: 'bid', ...choices.bids[index - 1]};
  }
  if (phase === 'discard') {
    const hand = [...view.hand], cards = [];
    for (let i = 0; i < 3; i++) cards.push(...hand.splice(Math.floor(rng() * hand.length), 1));
    return {type: 'discard', cards, contract: sample(choices.contracts, rng)};
  }
  if (phase === 'friend') return {type: 'friend', ...sample(choices.friends, rng)};
  if (phase === 'play') return {type: 'play', ...sample(choices.plays, rng)};
  throw new Error('A policy needs a live turn.');
}

function bidWithTemperament(view, aggressive) {
  let best = null, bestRoom = -Infinity;
  for (const suit of ['S', 'H', 'D', 'C', 'N']) {
    const suited = view.hand.filter(card => card[0] === suit);
    const masters = Number(view.hand.includes('JK')) + Number(view.hand.includes(mighty(suit)));
    const sideAces = view.hand.filter(c => c[0] !== suit && c.endsWith('A') && c !== mighty(suit)).length;
    const trumpHonors = suited.filter(c => ['A', 'K', 'Q'].includes(c.slice(1))).length;
    const ceiling = 9.5 + masters * 1.8 + sideAces * 1.2 + trumpHonors * .8 +
      (suit === 'N' ? (masters === 2 ? 1 : -2) : Math.max(0, suited.length - 2)) + (aggressive ? 1.8 : -.3);
    const bids = view.choices.bids.filter(b => b.suit === suit && b.points <= ceiling);
    const bid = bids[aggressive && bids.length > 2 ? 1 : 0];
    if (bid && ceiling - bid.points > bestRoom) { best = bid; bestRoom = ceiling - bid.points; }
  }
  return best ? {type: 'bid', ...best} : {type: 'pass'};
}

export function ruleAction(id, view, rng = Math.random) {
  if (id === 'random') return randomAction(view, rng);
  if (id === 'legacy') return botDecision(view);
  if (id === 'heuristic') return botDecision(view, policyPlay);
  if (id !== 'conservative' && id !== 'aggressive') throw new Error('Unknown rules policy: ' + id);
  if (view.phase === 'bid') return bidWithTemperament(view, id === 'aggressive');
  return botDecision(view, id === 'conservative' ? baselinePlay : policyPlay);
}
