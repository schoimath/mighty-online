export function settlementDetails(result, trump) {
  const {points, target, won, friend} = result;
  const bonuses = [];
  if (points === 20) bonuses.push('런');
  if (20 - points >= 10) bonuses.push('백런');
  if (trump === 'N') bonuses.push('노기루다');
  if (friend == null) bonuses.push('노프렌드');
  const base = (target - 10) * (won ? 1 : -1);
  const multiplier = 2 ** bonuses.length;
  return {base, bonuses, multiplier, unit: base * multiplier};
}

export function settlements(result, trump) {
  const {unit} = settlementDetails(result, trump);
  return Array.from({length: 5}, (_, seat) => {
    if (seat === result.declarer) return (result.friend == null ? 4 : 2) * unit;
    return seat === result.friend ? unit : -unit;
  });
}
