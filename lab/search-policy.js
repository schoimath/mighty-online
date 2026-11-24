import {botDecision, mighty, searchPlay} from '../engine.js';

export const SEARCH_POLICY_VERSION = 'reserve-joker-v2';

function chooseSearchPlay(view) {
  const {trick, trickNo, choices, bid, rules} = view;
  const master = mighty(bid.suit);
  // A Joker call can require even a losing Joker. On the penultimate trick
  // the search may also discard it if next trick's Joker is powerless.
  const usefulLater = trickNo < (rules.allowLastJoker ? 10 : 9);
  const cannotWin = trickNo === 1 || trick.some(play => play.card === master);
  if (usefulLater && cannotWin && !trick[0]?.jokerCall && choices.plays.some(p => p.card === 'JK') &&
      choices.plays.some(p => p.card !== 'JK' && p.card !== master)) {
    const plays = choices.plays.filter(p => p.card !== 'JK');
    return searchPlay({...view, choices:{...choices, plays}});
  }
  return searchPlay(view);
}

export function searchAction(view) {
  return botDecision(view, chooseSearchPlay);
}
