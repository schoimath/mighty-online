export const TABLE_SCORING_VERSION = 'contract-reward-13-v3';
export const LEGACY_TABLE_SCORING_VERSION = 'contract-reward-13-v2';

// Rounds dealt before versions were stored used the no-friend bonus.
export function roundScoringVersion(round) {
  return round.scoringVersion ?? LEGACY_TABLE_SCORING_VERSION;
}

export function settlementDetails(result, trump, scoringVersion = TABLE_SCORING_VERSION) {
  const {points, target, won, friend} = result;
  const bonuses = [];
  if (points === 20) bonuses.push('런');
  if (20 - points >= 10) bonuses.push('백런');
  if (trump === 'N') bonuses.push('노기루다');
  if (friend == null && scoringVersion === LEGACY_TABLE_SCORING_VERSION) bonuses.push('노프렌드');
  const difference = points - target;
  const base = won ? 2 * (target - 13) + difference : difference;
  const multiplier = 2 ** bonuses.length;
  return {base, bonuses, multiplier, unit: base * multiplier};
}

export function settlements(result, trump, scoringVersion = TABLE_SCORING_VERSION) {
  const {unit} = settlementDetails(result, trump, scoringVersion);
  if (unit === 0) return Array(5).fill(0);
  return Array.from({length: 5}, (_, seat) => {
    if (seat === result.declarer) return (result.friend == null ? 4 : 2) * unit;
    return seat === result.friend ? unit : -unit;
  });
}
