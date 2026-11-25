import {applyAction as applyEngineAction, pointsIn, sortHand} from './engine.js';

export function canDeclareSetting(state, seat) {
  return state.phase === 'play' && Number.isInteger(seat) && seat >= 0 && seat < state.hands.length &&
    seat === state.declarer && seat === state.turn && state.trick.length === 0 &&
    state.hands[seat].length > 0 && !state.settingAwaitingFriend;
}

function finishSetting(state, success, friendTrick = []) {
  const {declarer, friend, scores} = state;
  const remainingTricks = state.hands[declarer].length + Number(friendTrick.length > 0);
  const remaining = [...state.hands.flat(), ...friendTrick.map(play => play.card)].filter(card => pointsIn([card]));
  if (success) {
    scores[declarer] += remaining.length;
    state.captured[declarer].push(...remaining);
  } else {
    // Nobody won these in a played trick. Keep them in a team pool, so no
    // defender acquires another seat's private cards on their visible pile.
    state.settingOppositionPile = sortHand(remaining);
  }
  scores[declarer] += pointsIn(state.discarded);
  const points = scores[declarer] + (friend == null ? 0 : scores[friend]);
  state.hands = state.hands.map(() => []);
  state.phase = 'result';
  state.turn = null;
  state.friendKnown = true;
  state.result = {won:points >= state.bid.points, points, target:state.bid.points, declarer, friend,
    setting:{success, remainingTricks, remainingPoints:remaining.length}};
  return state;
}

// A verdict comes exclusively from the host's solver, never a network action.
export function resolveSetting(state, seat, success) {
  if (!canDeclareSetting(state, seat)) throw new Error('세팅은 주공이 선을 잡고 카드를 내기 전에만 선언할 수 있습니다.');
  if (typeof success !== 'boolean') throw new Error('세팅 판정이 완료되지 않았습니다.');
  if (!success && state.call.kind === 'first' && !state.friendKnown) {
    // Identify the partner before charging individual settlements.
    state.settingAwaitingFriend = true;
    return state;
  }
  return finishSetting(state, success);
}

// The engine judges the opening trick and determines its friend normally.
// Restore the previous piles because the claim had already awarded every
// unplayed honor, including the ones used for that trick, to the opposition.
export function finishSettingFriendTrick(state, seat, action) {
  const scores = state.scores.slice();
  const captured = state.captured.map(pile => pile.slice());
  applyEngineAction(state, seat, action);
  state.scores = scores;
  state.captured = captured;
  state.settingAwaitingFriend = false;
  state.trickNo = state.lastTrick.number;
  state.lastTrick.points = 0;
  return finishSetting(state, false, state.lastTrick.cards);
}
