import {pointsIn} from './engine.js';

// A live receipt may contain several plays that took place between two reads.
// Keep only the completed tricks still needed to animate this visit to the table.
export function rememberCompletedTricks(buffer, view, previous, recentTricks, firstNeeded = 1) {
  const last = view.lastTrick;
  for (const number of buffer.keys()) if (number < firstNeeded) buffer.delete(number);
  for (const trick of recentTricks ?? []) {
    if (trick.number >= firstNeeded && trick.cards?.length === 5) buffer.set(trick.number, trick);
  }
  if (!last || last.number < firstNeeded || buffer.has(last.number)) return;
  if (last.cards?.length === 5) buffer.set(last.number, last);
  else if (last.finalPlay && previous?.trickNo === last.number && previous.trick.length === 4) {
    buffer.set(last.number, {...last, cards:[...previous.trick, last.finalPlay]});
  }
}

// A trick with five visible cards has already been awarded and collected when
// we ask for the next frame. An ongoing trick is always read from the newest view.
export function nextTablePlay(shown, latest, buffer) {
  if (shown?.phase !== 'play' || !['play','result'].includes(latest.phase) ||
      shown.seat !== latest.seat || shown.dealNo !== latest.dealNo) return null;
  let number = shown.trickNo + Number(shown.trick.length === 5);
  let count = number === shown.trickNo ? shown.trick.length : 0;
  // On a long disconnect only a recent suffix is available. Resume at the
  // earliest actual play in that suffix rather than fabricating an older trick.
  if (number < latest.trickNo && !buffer.has(number)) {
    number = Math.min(latest.trickNo, ...[...buffer.keys()].filter(n => n > number));
    count = 0;
  }
  const finished = buffer.get(number);
  const moves = finished?.cards ?? (number === latest.trickNo && latest.phase === 'play' ? latest.trick : []);
  if (!moves[count]) return null;
  if (count && !shown.trick.every((play, i) => play.seat === moves[i]?.seat && play.card === moves[i]?.card)) return null;
  const trick = moves.slice(0, count + 1);
  return {number, trick, move:moves[count], winner:trick.length === 5 ? finished?.winner : undefined,
    live:!finished && trick.length === moves.length, behind:latest.trickNo - number};
}

export function intermediatePlayView(shown, latest, step) {
  const {move, trick, number, winner} = step;
  const reveal = !shown.friendKnown && latest.friendKnown && (shown.call?.kind === 'card' && move.card === shown.call.card ||
    shown.call?.kind === 'first' && number === 1 && winner !== undefined);
  return {...shown, phase:'play', trickNo:number, trick, turn:null, result:null,
    counts:shown.counts.map((_,seat) => 11 - number - Number(trick.some(play => play.seat === seat))),
    hand:move.seat === shown.seat ? shown.hand.filter(card => card !== move.card) : shown.hand,
    jokerPlayed:shown.jokerPlayed || move.card === 'JK',
    ...(reveal ? {friendKnown:true, friend:latest.friend, selfRole:latest.selfRole} : {}),
    choices:{...shown.choices, plays:[], canDeclareSetting:false}};
}

export function sweptTrickView(view, winner) {
  const covered = winner === view.declarer || winner === view.friend;
  const scoring = covered ? [] : view.trick.map(play => play.card).filter(card => pointsIn([card]));
  const lastTrick = {number:view.trickNo,winner,points:covered ? null : scoring.length,cards:covered ? [] : view.trick};
  return {...view,lastTrick,
    scores:view.scores.map((score,seat) => seat === winner ? covered ? null : score + scoring.length : score),
    captured:view.captured?.map((pile,seat) => seat === winner ? covered ? [] : [...pile,...scoring] : pile)};
}
