// Project ten-base settlement. W and S are derived separately.
export const SCORE_SCALE = 640;

export function settlements(result, trump) {
  const {won, points, target, declarer, friend} = result;
  const solo = friend == null;
  const sweep = won ? points === 20 : target - points >= 10;
  const base = won ? points - 10 : points - target;
  const unit = base * (sweep ? 2 : 1) * (trump === 'N' ? 2 : 1) * (solo ? 2 : 1);
  return Array.from({length: 5}, (_, seat) => {
    if (seat === declarer) return (solo ? 4 : 2) * unit;
    return seat === friend ? unit : -unit;
  });
}

export function outcomes(state) {
  if (!state.result) throw new Error('Settlement requires a finished round.');
  const {won, declarer, friend} = state.result;
  const pay = settlements(state.result, state.bid.suit);
  return pay.map((settlement, seat) => {
    const onAttack = seat === declarer || seat === friend;
    const role = seat === declarer ? (friend == null ? 'solo' : 'declarer') :
      seat === friend ? 'friend' : 'opposition';
    return {win: Number(onAttack === won), settlement, captured: state.captured[seat].length, role};
  });
}

export function utility(objective, outcome, {alpha = .5, lambdaRisk = .5} = {}) {
  const win = 2 * outcome.win - 1, x = outcome.settlement / SCORE_SCALE;
  switch (objective) {
    case 'win': return win;
    case 'score': return x;
    case 'balanced': return alpha * win + (1-alpha) * x;
    case 'downside_averse': return x - lambdaRisk * Math.max(-x, 0) ** 2;
    default: throw new Error('Unknown objective: ' + objective);
  }
}
