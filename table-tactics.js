import {jokerActive, mighty, pointsIn, winningPlay} from './engine.js';

export function conserveOpeningJoker(view) {
  if (view.phase !== 'play' || view.trickNo !== 1 || view.trick[0]?.jokerCall) return view;
  const {plays} = view.choices;
  if (!plays.some(move => move.card === 'JK')) return view;
  const alternatives = plays.filter(move => move.card !== 'JK');
  if (!alternatives.length) return view;
  // A declarer can keep the lead with the Mighty if it is the only alternative.
  // A follower facing that same choice may need to save the Mighty instead.
  if (view.trick.length && alternatives.every(move => move.card === mighty(view.bid.suit))) return view;
  return {...view, choices:{...view.choices, plays:alternatives}};
}

export function conserveMightyOnTrumpAce(view) {
  if (view.phase !== 'play' || view.selfRole !== 'friend' || view.trickNo >= 9) return view;
  const master = mighty(view.bid.suit);
  const lead = view.trick[0];
  if (view.call?.kind !== 'card' || view.call.card !== master ||
      lead?.seat !== view.declarer || lead.card !== view.bid.suit + 'A') return view;
  if (winningPlay(view).seat !== view.declarer) return view;

  const {plays} = view.choices;
  if (!plays.some(move => move.card === master)) return view;
  const ordinary = plays.filter(move => move.card !== master && move.card !== 'JK');
  if (!ordinary.length) return view;

  // Only an active Joker behind this seat can still beat the declarer's trump ace.
  const jokerCouldFollow = view.trick.length < 4 && jokerActive(view) && !view.hand.includes('JK') &&
    !view.playedTricks?.some(trick => trick.cards.some(move => move.card === 'JK'));
  if (jokerCouldFollow) {
    const defensePoints = view.scores.reduce((sum, points, seat) =>
      seat === view.declarer || seat === view.seat ? sum : sum + points, 0);
    const exposed = pointsIn(view.trick.map(move => move.card)) +
      Number(ordinary.every(move => pointsIn([move.card]) > 0));
    // Leave an expensive trick, or one that can set the contract, to the underlying model.
    if (exposed >= 3 || defensePoints + exposed > 20 - view.bid.points) return view;
  }
  return {...view, choices:{...view.choices, plays:ordinary}};
}
