import {DECK, jokerActive, legalPlays, mighty, strength} from './engine.js';

// The declarer must keep the lead throughout, so every follower responds to the
// same lead, independently of earlier followers. An inactive Joker lead already
// loses to the first ordinary card and never needs to be expanded.
export function analyzeSetting(round, {maxWork = 160_000} = {}) {
  if (round.phase !== 'play' || round.turn !== round.declarer || round.trick.length) {
    throw new Error('주공이 선을 잡은 트릭에서만 세팅을 판정할 수 있습니다.');
  }
  const own = round.hands[round.declarer];
  const others = round.hands.filter((_, seat) => seat !== round.declarer);
  const master = mighty(round.bid.suit);
  if (others.some(hand => hand.includes(master))) return {success:false};

  const full = (1 << own.length) - 1;
  const base = full + 1;
  const size = new Uint8Array(base);
  for (let mask = 1; mask <= full; mask++) size[mask] = 1 + size[mask & (mask - 1)];
  const stateAt = (mask, trick) => ({
    rules:round.rules, bid:round.bid, trickNo:round.trickNo + own.length - size[mask], trick
  });
  const held = (cards, mask) => cards.filter((_, i) => mask & (1 << i));
  const ownLeads = [];
  const replyCaches = others.map(() => new Map());
  const memo = Array.from({length:base}, () => new Map());
  const relevant = [];
  const rankOrder = cards => cards.map((card, i) => [card, i])
    .sort(([a], [b]) => DECK.indexOf(a) - DECK.indexOf(b));
  const sortedOthers = others.map(rankOrder);
  let work = 0;
  const exhausted = Symbol('setting search limit');
  function spend() {
    if (++work > maxWork) throw exhausted;
  }

  function leads(mask) {
    if (ownLeads[mask]) return ownLeads[mask];
    const state = stateAt(mask, []);
    ownLeads[mask] = legalPlays(state, held(own, mask)).map(move => {
      const index = own.indexOf(move.card);
      const trick = [move];
      const active = jokerActive(state, trick);
      const variant = move.jokerCall ? 5 : move.suit ? 1 + 'SHDC'.indexOf(move.suit) : 0;
      return {move, next:mask ^ (1 << index), id:index * 6 + variant,
        state:{...state, trick}, value:strength(move.card, round.bid.suit, trick, active), active};
    }).filter(lead => lead.move.card !== 'JK' || lead.active);
    return ownLeads[mask];
  }

  function response(seat, mask, lead) {
    // Mask size fixes the trick number, including opening/final Joker effects.
    const cache = replyCaches[seat], key = mask * (own.length * 6) + lead.id;
    if (cache.has(key)) return cache.get(key);
    spend();
    const options = legalPlays(lead.state, held(others[seat], mask));
    let next = null;
    if (!options.some(({card}) => strength(card, round.bid.suit, lead.state.trick, lead.active) > lead.value)) {
      next = [];
      const legal = new Set(options.map(o => o.card));
      const suits = new Set();
      // Within one ordinary suit the weakest legal discard is the strongest
      // defense: keeping the higher card can mimic every future lower one.
      // First check *all* legal cards above for an immediate overtake.
      for (const [card, i] of sortedOthers[seat]) {
        if (!legal.has(card) || suits.has(card[0])) continue;
        suits.add(card[0]);
        next.push(mask ^ (1 << i));
      }
    }
    cache.set(key, next);
    return next;
  }

  function relevantCards(ownMask) {
    if (relevant[ownMask]) return relevant[ownMask];
    const remaining = held(own, ownMask);
    const suits = new Set(remaining.includes('JK') ? 'SHDC' : remaining.map(card => card[0]));
    suits.add(round.bid.suit);
    // A defender's cards in suits that can never be led or trump are
    // interchangeable discards. The number of such cards is implied by depth.
    relevant[ownMask] = others.map(hand => hand.reduce((mask, card, i) =>
      card === 'JK' || suits.has(card[0]) ? mask | (1 << i) : mask, 0));
    return relevant[ownMask];
  }

  function solve(ownMask, hands) {
    spend();
    const relevantNow = relevantCards(ownMask);
    const key = hands.reduce((value, hand, seat) => value * base + (hand & relevantNow[seat]), 0);
    const known = memo[ownMask].get(key);
    if (known !== undefined) return known;
    // One lead must withstand every reply. Recurse after the cards are shown
    // so the declarer's next lead can depend on what all four players played.
    for (const lead of leads(ownMask)) {
      spend();
      const options = [];
      for (let seat = 0; seat < hands.length; seat++) {
        const replies = response(seat, hands[seat], lead);
        if (!replies) break;
        const relevantNext = relevantCards(lead.next)[seat];
        const seen = new Set();
        options.push(replies.filter(mask => {
          const projection = mask & relevantNext;
          if (seen.has(projection)) return false;
          seen.add(projection);
          return true;
        }));
      }
      if (options.length !== hands.length) continue;
      const nextHands = hands.slice();
      function allReplies(seat) {
        if (seat === hands.length) return solve(lead.next, nextHands);
        return options[seat].every(hand => { nextHands[seat] = hand; return allReplies(seat + 1); });
      }
      if (!lead.next || allReplies(0)) {
        memo[ownMask].set(key, lead);
        return lead;
      }
    }
    memo[ownMask].set(key, null);
    return null;
  }

  try {
    let hands = others.map(() => full);
    let lead = solve(full, hands);
    if (!lead) return {success:false};
    // Replay one branch of the proven strategy. Only the declarer's leads are public.
    const line = [];
    while (lead) {
      line.push(lead.move);
      if (!lead.next) break;
      hands = hands.map((mask, seat) => response(seat, mask, lead)[0]);
      lead = solve(lead.next, hands);
    }
    return {success:true, line};
  } catch (error) {
    if (error !== exhausted) throw error;
    return {success:false, indeterminate:true};
  }
}

export function canSweepRemaining(round) {
  return analyzeSetting(round).success;
}
