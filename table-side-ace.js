import {DECK, mighty} from './engine.js';
import {shouldDeclareSetting} from './bot-setting.js';

// With the Mighty, Joker and trump ace under declarer control, a fresh side
// ace can lose only to a ruff. Count the suit still outside, including the
// called ace. Prefer a suit we can actually lead, with a cheap entry card.
function entryFor(view, target, unseen, trumpsOut) {
  const suit = target[0];
  const outside = unseen.filter(card => card[0] === suit);
  if (outside.at(-1) !== target) return null;
  const own = DECK.filter(card => card[0] === suit && view.hand.includes(card));
  if (!own.length || DECK.indexOf(own[0]) >= DECK.indexOf(target)) return null;
  // On opening lead with eight outside, even after assigning the ace to our
  // partner, each defender has at most ~10% chance of being void. Do not
  // feed a cashable side ace into a depleted suit while trumps are still out.
  if (suit !== view.bid.suit && trumpsOut && outside.length < 8) return null;
  return {target, card:own[0], outside:outside.length, length:own.length};
}

export function preferSideAcePlan(view, action) {
  if (view.seat !== view.declarer || !view.bid || view.bid.suit === 'N') return action;
  const calling = view.phase === 'friend' && action.type === 'friend';
  const leading = view.phase === 'play' && action.type === 'play' && !view.trick.length &&
    !view.friendKnown && view.call?.kind === 'card';
  if (!calling && !leading) return action;
  const trump = view.bid.suit, master = mighty(trump);
  if (leading && (view.call.card === master || view.call.card === 'JK')) return action;
  const history = view.playedTricks ?? [];
  if (history.length !== view.trickNo - 1) return action;
  const owned = new Set(view.hand), known = new Set([...owned, ...view.discarded]);
  for (const trick of history) {
    for (const play of trick.cards) {
      known.add(play.card);
      if (play.seat === view.seat) owned.add(play.card);
    }
  }
  if (![master, 'JK', trump + 'A'].every(card => owned.has(card))) return action;
  const unseen = DECK.filter(card => !known.has(card));
  const trumpsOut = unseen.some(card => card[0] === trump);

  if (calling) {
    if (view.choices.friends.some(call => call.kind === 'none') && shouldDeclareSetting({...view, phase:'play'})) {
      return {type:'friend', kind:'none'};
    }
    const allowed = new Set(view.choices.friends.filter(call => call.kind === 'card').map(call => call.card));
    const entries = ['S','H','D','C'].map(suit => unseen.filter(card => card[0] === suit).at(-1))
      .filter(card => allowed.has(card)).map(card => entryFor(view, card, unseen, trumpsOut)).filter(Boolean);
    // A reachable side ace offers an opening entry. If it costs a bare K/Q,
    // or no side ace can be reached, pass instead to the highest outside
    // trump or to a side master underneath our own honors.
    const priority = entry => {
      if (['K','Q'].includes(entry.card.slice(1))) return 3;
      if (entry.target[0] === trump) return 1;
      return entry.target.endsWith('A') ? 0 : 2;
    };
    entries.sort((a,b) => priority(a) - priority(b) || b.outside - a.outside || a.length - b.length ||
      Number(b.target === action.card) - Number(a.target === action.card));
    if (entries.length) return {type:'friend', kind:'card', card:entries[0].target};
    return view.choices.friends.some(call => call.kind === 'none') ? {type:'friend', kind:'none'} : action;
  }

  // Once play has started preserve the model's trump draws; a later entry
  // is secure when defenders no longer have trump. Never lead a Joker call
  // instead of the ordinary three when passing the lead.
  if (view.call.card[0] !== trump && view.trickNo > 1 && trumpsOut) return action;
  const entry = entryFor(view, view.call.card, unseen, trumpsOut);
  const move = entry && view.choices.plays.find(play => play.card === entry.card && !play.jokerCall);
  return move ? {type:'play', ...move} : action;
}
