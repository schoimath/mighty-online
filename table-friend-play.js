import {DECK, jokerActive, leadSuit, mighty, pointsIn, strength, winningPlay} from './engine.js';

const rank = card => DECK.indexOf(card) % 13;
const rankAbove = (higher, lower, master) => higher !== master && higher[0] === lower[0] && rank(higher) > rank(lower);

// A small opening lead in the called ace's suit offers the friend the lead.
function offersCalledAce(view, lead, master) {
  const ace = view.call?.card;
  return view.call?.kind === 'card' && ace?.endsWith('A') && ace !== master &&
    ace[0] !== view.bid.suit && lead?.seat === view.declarer && lead.card[0] === ace[0] &&
    !pointsIn([lead.card]) && !lead.jokerCall;
}

function returnTrump(view, action, master) {
  const trump = view.bid.suit;
  if (view.trickNo !== 2 || trump === 'N' || action.card[0] === trump ||
      action.card === master || action.card === 'JK' || action.jokerCall) return action;
  const last = view.playedTricks?.[0];
  if (last?.winner !== view.seat || !offersCalledAce(view, last.cards[0], master) ||
      !last.cards.some(p => p.seat === view.seat && p.card === view.call.card)) return action;
  // Keep a fresh side winner. Otherwise give the declarer a cheap trump
  // entry and draw opposing trumps instead of reopening the spent ace's suit.
  const seen = new Set([...view.hand, ...last.cards.map(p => p.card)]);
  if (!DECK.some(card => !seen.has(card) && rankAbove(card, action.card, master))) return action;
  const low = view.choices.plays.filter(p => p.card[0] === trump && !pointsIn([p.card]))
    .sort((a,b) => rank(a.card) - rank(b.card))[0];
  return low ? {type:'play', ...low} : action;
}

export function coordinateFriendPlay(view, action) {
  if (action.type !== 'play' || view.selfRole !== 'friend' || view.choices.plays.length < 2) return action;
  const {trick, bid, hand} = view;
  const master = mighty(bid.suit);
  if (!trick.length) return returnTrump(view, action, master);
  const leader = trick[0], winner = winningPlay(view), active = jokerActive(view);
  const power = card => strength(card, bid.suit, trick, active);
  if (view.trickNo === 1 && !view.friendKnown && offersCalledAce(view, leader, master) &&
      power(winner.card) < power(view.call.card) &&
      !(action.card[0] === view.call.card[0] && power(action.card) > power(winner.card) && trick.length === 4)) {
    const ace = view.choices.plays.find(p => p.card === view.call.card);
    if (ace) return {type:'play', ...ace};
  }

  if (winner.seat !== view.declarer || !leadSuit(trick)) return action;
  const seen = new Set([...hand, ...trick.map(p => p.card)]);
  for (const past of view.playedTricks ?? []) for (const p of past.cards) seen.add(p.card);
  const unseen = DECK.filter(card => !seen.has(card));
  // Last to act, or nobody can possibly beat the declarer even with a free
  // discard. No assumptions about which opponent is void are needed.
  if (trick.length !== 4 && unseen.some(c => power(c) > power(winner.card))) return action;
  const ducks = view.choices.plays.filter(p => p.card !== master && p.card !== 'JK' &&
    power(p.card) < power(winner.card));
  if (!ducks.length) return action;
  if (action.card !== master && action.card !== 'JK' && pointsIn([action.card]) &&
      power(action.card) < power(winner.card)) return action;

  // Bank a vulnerable side ten, jack or queen while it has a safe home.
  const feed = ducks.filter(({card}) => card[0] !== bid.suit && ['10','J','Q'].includes(card.slice(1)) &&
    unseen.some(c => rankAbove(c, card, master)))
    .sort((a,b) => power(a.card) - power(b.card) || rank(a.card) - rank(b.card))[0];
  if (feed) return {type:'play', ...feed};
  if (action.card !== master && (action.card !== 'JK' || (view.trickNo >= 9 && !view.rules.allowLastJoker))) return action;
  const spare = ducks.filter(p => !pointsIn([p.card])).sort((a,b) =>
    Number(a.card[0] === bid.suit) - Number(b.card[0] === bid.suit) ||
    rank(a.card) - rank(b.card))[0];
  return spare ? {type:'play', ...spare} : action;
}
