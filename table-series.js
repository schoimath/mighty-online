// The ordinal belongs to the deal: it stays the same through redeals, settlement and reconnection.
export function handSeries(roundNumber, roundLimit) {
  if (!Number.isSafeInteger(roundNumber) || roundNumber < 1 ||
      (roundLimit !== null && roundLimit !== 10 && roundLimit !== 20) ||
      (roundLimit !== null && roundNumber > roundLimit)) return null;
  return {roundNumber, roundLimit};
}

export function seriesFromBoard(board, settled = false) {
  if (!Number.isSafeInteger(board?.rounds) || board.rounds < 0) return null;
  return handSeries(board.rounds + (settled ? 0 : 1), board.roundLimit);
}

export function matchesOfferedSeries(series, board) {
  if (series === undefined) return true; // Deals offered by older hosts.
  const next = seriesFromBoard(board);
  return Boolean(next && series?.roundNumber === next.roundNumber && series.roundLimit === next.roundLimit);
}
