import {DECK, jokerActive, leadSuit, legalPlays, mighty, strength} from './engine.js';

// A claim commits the bot before the host checks the actual deal. Prove a
// sufficient line using only this seat's cards and the tricks everyone saw.
export function shouldDeclareSetting(view) {
  if (view.phase !== 'play' || view.turn !== view.seat || view.declarer !== view.seat ||
      view.trick.length || !view.hand.length || view.settingAwaitingFriend) return false;
  const trump = view.bid.suit;
  const seen = new Set([...view.hand, ...view.discarded]);
  for (const trick of view.playedTricks ?? []) {
    for (const {card} of trick.cards) seen.add(card);
  }
  const unseen = DECK.filter(card => !seen.has(card));
  if (unseen.includes(mighty(trump))) return false;
  const ordinary = unseen.filter(card => card !== 'JK');
  const possibleTrumps = ordinary.filter(card => card[0] === trump).length;
  const failed = new Set();

  function prove(remaining, maxTrumps, opposingJoker) {
    if (!remaining) return true;
    const key = (remaining * 11 + maxTrumps) * 2 + Number(opposingJoker);
    if (failed.has(key)) return false;
    const hand = view.hand.filter((card, i) => remaining & (1 << i));
    const state = {bid:view.bid, rules:view.rules, trickNo:view.trickNo + view.hand.length - hand.length, trick:[]};
    for (const move of legalPlays(state, hand)) {
      if (move.jokerCall && !opposingJoker) continue;
      const trick = [move];
      const active = jokerActive(state, trick);
      if (move.card === 'JK' && !active) continue;
      const value = strength(move.card, trump, trick, active);
      if (opposingJoker && strength('JK', trump, trick, active) > value) continue;
      if (ordinary.some(card => (maxTrumps || card[0] !== trump) && strength(card, trump, trick, active) > value)) continue;

      // Without an opposing Mighty or Joker, every defender holding trump
      // must follow a trump lead, including when our Joker requests trump.
      const drawsTrump = leadSuit(trick) === trump && !opposingJoker;
      const nextMax = drawsTrump ? Math.max(0, maxTrumps - 1) : maxTrumps;
      const next = remaining ^ (1 << view.hand.indexOf(move.card));
      if (prove(next, nextMax, opposingJoker && !move.jokerCall)) return true;
    }
    failed.add(key);
    return false;
  }

  return prove((1 << view.hand.length) - 1, Math.min(view.hand.length, possibleTrumps), unseen.includes('JK'));
}
