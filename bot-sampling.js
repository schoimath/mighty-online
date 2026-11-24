// Draw hypothetical hands from cards the player has not observed. A seat that
// previously failed to follow suit cannot be dealt that suit later.
export function sampler(view, history, deck, master, sortHand) {
  const {seat, hand, discarded, declarer, bid, counts} = view;
  const seen = new Set([...hand, ...discarded]);
  const voids = Array.from({length: 5}, () => new Set());
  const withoutJoker = new Set();
  const scores = [0,0,0,0,0];
  function observe(cards) {
    let lead = null;
    for (const p of cards) {
      seen.add(p.card);
      if (lead && p.card !== 'JK' && p.card !== master && p.card[0] !== lead) voids[p.seat].add(lead);
      if (cards[0].jokerCall && p !== cards[0] && p.card !== 'JK' && p.card !== master) withoutJoker.add(p.seat);
      if (!lead) lead = p.card === 'JK' ? p.suit : p.card[0];
    }
  }
  for (const t of history) { observe(t.cards); scores[t.winner] += t.points; }
  observe(view.trick);
  const unknown = deck.filter(card => !seen.has(card));
  const spaces = counts.map((count,s) => s === seat ? 0 : count);
  spaces.push(seat === declarer ? 0 : 3);
  if (unknown.length !== spaces.reduce((a,b) => a+b,0)) return null;
  const candidates = unknown.map(card => {
    const destinations = [];
    for (let to = 0; to < 6; to++) {
      if (!spaces[to] || (to < 5 && voids[to].has(card[0])) || (card === 'JK' && withoutJoker.has(to))) continue;
      let likelihood = 1;
      if (to === declarer && card[0] === bid.suit) likelihood = 1.65;
      if (to === 5 && (card === master || card === 'JK' || card[0] === bid.suit)) likelihood = 0.12;
      if (view.call?.card === card && (to === 5 || to === declarer)) likelihood *= 0.06;
      destinations.push({to, likelihood});
    }
    return {card, destinations};
  });
  // Stable observation seed makes repeated decisions replay identically.
  let seed = 2166136261;
  for (const card of seen) for (const ch of card) seed = Math.imul(seed ^ ch.charCodeAt(0),16777619);
  seed ^= (view.seat + 1) * 17 + view.trickNo;
  function random() {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  }
  return () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const open = spaces.slice(), hands = Array.from({length:6}, () => []);
      hands[seat] = hand;
      const ordered = candidates.map(entry => ({entry, tie:random()})).sort((a,b) =>
        a.entry.destinations.length - b.entry.destinations.length || a.tie - b.tie);
      let valid = true;
      for (const {entry: {card, destinations}} of ordered) {
        let total = 0;
        for (const {to, likelihood} of destinations) total += open[to] * likelihood;
        if (!total) { valid = false; break; }
        let draw = random() * total;
        for (const {to, likelihood} of destinations) {
          draw -= open[to] * likelihood;
          if (draw < 0) { hands[to].push(card); open[to]--; break; }
        }
      }
      if (!valid) continue;
      let friend = view.friend;
      if (!view.friendKnown && view.call?.kind === 'card') {
        const holder = hands.findIndex(cards => cards.includes(view.call.card));
        friend = holder < 0 || holder === 5 || holder === declarer ? null : holder;
      }
      for (let other = 0; other < 5; other++) if (other !== seat) sortHand(hands[other]);
      return {hands: hands.slice(0,5), discarded: seat === declarer ? discarded : hands[5], scores, friend};
    }
    return null;
  };
}
