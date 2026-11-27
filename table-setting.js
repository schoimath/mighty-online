import {applyAction as applyEngineAction, legalPlays, pointsIn, sortHand} from './engine.js';

export function canDeclareSetting(state, seat) {
  return state.phase === 'play' && Number.isInteger(seat) && seat >= 0 && seat < state.hands.length &&
    seat === state.declarer && seat === state.turn && state.trick.length === 0 &&
    state.trickNo < 10 && state.hands[seat].length > 1 && !state.settingAwaitingFriend;
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
export function resolveSetting(state, seat, verdict) {
  if (!canDeclareSetting(state, seat)) throw new Error('세팅은 1~9번째 트릭에서 주공이 선을 잡고 카드를 내기 전에 선언할 수 있습니다.');
  if (verdict?.success !== true) throw new Error('남은 트릭을 모두 딸 수 있다고 확인된 경우에만 세팅할 수 있습니다.');
  const hand = [...state.hands[seat]];
  if (!Array.isArray(verdict.line) || verdict.line.length !== hand.length) throw new Error('세팅 카드 순서가 올바르지 않습니다.');
  const line = [];
  for (const move of verdict.line) {
    const legal = legalPlays({...state, trickNo:state.trickNo + line.length}, hand).find(play =>
      play.card === move?.card && play.suit === move.suit && play.jokerCall === move.jokerCall);
    if (!legal) throw new Error('세팅 카드 순서가 올바르지 않습니다.');
    hand.splice(hand.indexOf(legal.card), 1);
    line.push(legal);
  }
  finishSetting(state, true);
  state.result.setting.line = line;
  return state;
}

// Complete a penalty already recorded by an older version before the first friend was known.
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
