export const AUCTION_BEAT_MS = 1350;
export const FRIEND_ANNOUNCEMENT_MS = 2200;

const paceFactors = {slow:1.45, normal:1, fast:0.65};

export function normalizeGameSpeed(pace) {
  return typeof pace === 'string' && Object.hasOwn(paceFactors, pace) ? pace : 'normal';
}

export function paceMultiplier(pace) {
  return paceFactors[normalizeGameSpeed(pace)];
}

export function tableDelay(milliseconds, pace) {
  return Math.round(milliseconds * paceMultiplier(pace));
}

export function botTurnDelay(game, pace, {showRedeal = true} = {}) {
  let pause = 560;
  if (game.phase === 'bid') {
    pause = game.bidHistory.length ? AUCTION_BEAT_MS : 1800;
    if (showRedeal && !game.bidHistory.length && game.dealNo > 1) pause += AUCTION_BEAT_MS;
  } else if (game.phase === 'discard') {
    pause += AUCTION_BEAT_MS;
  } else if (game.phase === 'play' && !game.trick.length) {
    pause = game.trickNo === 1 ? FRIEND_ANNOUNCEMENT_MS : 1050;
  }
  return tableDelay(pause, pace);
}
