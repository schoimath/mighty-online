export const TABLE_SCORING_VERSION = 'contract-reward-13-v2';

export function settlementDetails(result, trump) {
  const {points, target, won, friend} = result;
  const bonuses = [];
  if (points === 20) bonuses.push('런');
  if (20 - points >= 10) bonuses.push('백런');
  if (trump === 'N') bonuses.push('노기루다');
  if (friend == null) bonuses.push('노프렌드');
  const difference = points - target;
  const base = won ? 2 * (target - 13) + difference : difference;
  const multiplier = 2 ** bonuses.length;
  return {base, bonuses, multiplier, unit: base * multiplier};
}

export function settlements(result, trump) {
  const {unit} = settlementDetails(result, trump);
  if (unit === 0) return Array(5).fill(0);
  return Array.from({length: 5}, (_, seat) => {
    if (seat === result.declarer) return (result.friend == null ? 4 : 2) * unit;
    return seat === result.friend ? unit : -unit;
  });
}
