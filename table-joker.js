const isJoker = move => move.card === 'JK';

// Only cards that have appeared on the felt count, including the fifth card
// of a trick that was immediately swept into a covered pile.
export function jokerWasPlayed(view) {
  return view.trick.some(isJoker) || view.lastTrick?.finalPlay?.card === 'JK' ||
    Boolean(view.lastTrick?.cards?.some(isJoker) || view.playedTricks?.some(trick => trick.cards.some(isJoker)));
}

export function withJokerStatus(view, jokerPlayed = view.jokerPlayed ?? jokerWasPlayed(view)) {
  const {choices} = view;
  if (jokerPlayed && choices.plays.some(move => move.jokerCall)) {
    return {...view, jokerPlayed, choices:{...choices, plays:choices.plays.filter(move => !move.jokerCall)}};
  }
  return view.jokerPlayed === jokerPlayed ? view : {...view, jokerPlayed};
}
