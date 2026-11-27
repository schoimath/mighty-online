// A visitor can catch up on tricks played since their last live receipt.
// Joining or reopening an old hand must not expose the contents of covered piles.
const WINDOW_MS = 30_000;
const MAX_TRICKS = 3;
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

export function liveTrickPlayback(secret) {
  let key;
  return async (receipt, round, previous) => {
    key ??= crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign','verify']);
    const signer = await key;
    const completed = round.lastTrick?.number ?? 0;
    const now = receipt.serverNow;
    const payload = stamp => encoder.encode(['mighty/live-tricks/v1', receipt.handId, round.dealNo, receipt.seat, stamp].join('|'));
    const stamp = completed + '.' + now;
    const signature = await crypto.subtle.sign('HMAC', signer, payload(stamp));
    const playCursor = stamp + '.' + hex(signature);

    const parts = typeof previous === 'string' && /^(10|[0-9])\.(\d{1,15})\.([0-9a-f]{64})$/.exec(previous);
    if (!parts || Number(parts[1]) >= completed || Number(parts[2]) > now || now - Number(parts[2]) > WINDOW_MS) {
      return {...receipt, playCursor};
    }
    const bytes = Uint8Array.from(parts[3].match(/../g), pair => parseInt(pair,16));
    if (!await crypto.subtle.verify('HMAC',signer,bytes,payload(parts[1] + '.' + parts[2]))) {
      return {...receipt, playCursor};
    }
    // The game records actual table plays, including the last play that resolves
    // a first-trick friend after a claim. Never derive moves from settlement cards.
    const source = round.playedTricks?.length ? round.playedTricks : [round.lastTrick];
    const oldest = Math.max(Number(parts[1]) + 1, completed - MAX_TRICKS + 1);
    const recentTricks = source.filter(trick => trick && trick.number >= oldest && trick.number <= completed).map(trick => ({
      number:trick.number, winner:trick.winner,
      cards:trick.cards.map(({seat, card, suit, jokerCall}) => ({seat, card, ...(suit ? {suit} : {}), ...(jokerCall ? {jokerCall:true} : {})}))
    }));
    return {...receipt, playCursor, recentTricks};
  };
}
