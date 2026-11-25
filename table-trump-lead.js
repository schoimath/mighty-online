import {DECK, leadSuit, mighty} from './engine.js';

// On lead the declarer knows the burial and remembers every card that was
// face-up, including cards later collected into a covered partnership pile.
export function preferTrumpLead(view, action) {
  if (action.type !== 'play' || view.selfRole !== 'declarer' || view.trick.length ||
      view.trickNo === 1 || view.bid.suit === 'N') return action;
  const trump = view.bid.suit, master = mighty(trump);
  if (action.card[0] === trump || action.card === master || action.card === 'JK' || action.jokerCall) return action;
  const ownTrumps = view.hand.filter(card => card[0] === trump);
  if (ownTrumps.length < 4) return action;

  const history = view.playedTricks ?? [];
  if (history.length !== view.trickNo - 1 || history.some(trick => trick.cards.length !== 5)) return action;
  const gone = new Set(view.discarded);
  const voidInTrump = new Set();
  const side = action.card[0];
  let friendRuffedSide = false;
  for (const trick of history) {
    const suit = leadSuit(trick.cards);
    for (const {seat, card} of trick.cards) {
      gone.add(card);
      if (suit === trump && card[0] !== trump && card !== 'JK' && card !== master) voidInTrump.add(seat);
      if (view.friendKnown && seat === view.friend && trick.winner === seat &&
          suit === side && card[0] === trump) friendRuffedSide = true;
    }
  }
  const remaining = DECK.filter(card => !gone.has(card));
  const liveTrumps = remaining.filter(card => card[0] === trump);
  // Require several consecutive winners: a single high trump can be more
  // valuable as an entry after establishing a side suit.
  if (!liveTrumps.slice(-3).every(card => ownTrumps.includes(card))) return action;
  const friendCard = view.call?.kind === 'card' ? view.call.card : null;
  const outside = liveTrumps.filter(card => !ownTrumps.includes(card) && card !== friendCard);
  const canHoldTrump = seat => seat !== view.seat && seat !== view.friend && !voidInTrump.has(seat);
  if (outside.length < 2 || !view.counts.some((count, seat) => count && canHoldTrump(seat))) return action;

  if ([master, 'JK'].some(card => !gone.has(card) && !view.hand.includes(card) && card !== friendCard)) return action;

  // Keep entries to the friend: their called suit, an available Joker call,
  // or a side suit they already won by ruffing with a natural trump.
  if (!view.friendKnown && friendCard &&
      (friendCard[0] === side || (friendCard === 'JK' && view.choices.plays.some(p => p.card === action.card && p.jokerCall)))) return action;
  if (friendRuffedSide && !voidInTrump.has(view.friend)) return action;
  // Allow a fresh side-suit winner to cash before another seat becomes void.
  const highSide = remaining.filter(card => card[0] === side && card !== master).at(-1);
  if (action.card === highSide && !history.some(trick => leadSuit(trick.cards) === side)) return action;
  const draw = view.choices.plays.find(play => play.card === liveTrumps.at(-1));
  return draw ? {type:'play', ...draw} : action;
}
