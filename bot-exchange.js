const suits = ['S', 'H', 'D', 'C'];
const rankCost = {2: 0, 3: 0.2, 4: 0.4, 5: 0.6, 6: 0.8, 7: 1, 8: 1.2, 9: 1.4,
  10: 1.6, J: 2.2, Q: 3.2, K: 6.5, A: 13};
const honors = new Set(['10', 'J', 'Q', 'K', 'A']);

// Buried honors score immediately. Compare all 286 triples so a defender's
// future lead in a discarded suit can be trumped by the declarer.
export function selectDiscard(hand, trump, mightyCard) {
  const lengths = suits.map(suit => hand.filter(card => card[0] === suit).length);
  const cost = hand.map(card => {
    if (card === mightyCard || card === 'JK') return 150;
    const rank = card.slice(1);
    return rankCost[rank] + (card[0] === trump ? 40 : 0) - (honors.has(rank) ? 6 : 0);
  });
  let best, bestScore = -Infinity;
  for (let first = 0; first < hand.length - 2; first++) {
    for (let second = first + 1; second < hand.length - 1; second++) {
      for (let third = second + 1; third < hand.length; third++) {
        const cards = [hand[first], hand[second], hand[third]];
        let score = -cost[first] - cost[second] - cost[third];
        for (const [index, suit] of suits.entries()) {
          if (suit === trump || trump === 'N') continue;
          const cut = cards.filter(card => card[0] === suit).length;
          if (!cut) continue;
          const left = lengths[index] - cut;
          if (left === 0) score += 2.2;
          else if (left === 1) score += 0.55;
        }
        if (score > bestScore) { bestScore = score; best = cards; }
      }
    }
  }
  return best;
}
