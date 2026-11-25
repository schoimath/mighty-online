import {DECK, jokerActive, leadSuit, mighty, pointsIn, ratedPlays, strength, winningPlay} from '../engine.js';

const rankOf = new Map(DECK.map((card, i) => [card, i % 13]));

function onOurSide(view, seat) {
  if (seat === view.seat) return 1;
  if (view.selfRole === 'friend') return Number(seat === view.declarer);
  if (view.selfRole === 'declarer') return view.friendKnown ? Number(seat === view.friend) : .25;
  if (seat === view.declarer || seat === view.friend) return 0;
  return view.friendKnown ? 1 : 2/3;
}

// All inputs are public plays or cards this seat has personally seen.
export function endgameOptions(v) {
  const rated = ratedPlays(v), trump = v.bid.suit, master = mighty(trump);
  const seen = new Set([...v.hand, ...v.discarded, ...v.trick.map(p => p.card)]);
  for (const t of v.playedTricks ?? []) for (const p of t.cards) seen.add(p.card);
  const unknown = DECK.filter(c => !seen.has(c));
  const attack = ['declarer','friend'].includes(v.selfRole);
  const context = [1, Number(!v.trick.length), v.trick.length/4, (9-v.trickNo)/2,
    Number(attack), Number(v.friendKnown), Number(trump==='N'), Number(v.rules.allowLastJoker),
    pointsIn(v.trick.map(p=>p.card))/4, Number(v.selfRole==='declarer')];
  return rated.map(({move,value}) => {
    const card = move.card, after = [...v.trick,{...move,seat:v.seat}];
    const win = winningPlay(v,after), lead = leadSuit(after), active = jokerActive(v,after);
    const winnerStrength = strength(win.card,trump,after,active);
    const canOvertake = unknown.filter(c => strength(c,trump,after,active)>winnerStrength).length;
    const rank = rankOf.get(card);
    const higherInSuit = unknown.filter(c => c[0]===card[0] && rankOf.get(c)>rank).length;
    const ally = onOurSide(v, win.seat), honor = pointsIn([card]);
    const hasTrump = trump!=='N' && card[0]===trump;
    const others = v.hand.filter(c=>c!==card);
    const vector = [(value-rated[0].value)/8, Number(win.seat===v.seat), ally, ally*honor, honor,
      Number(card===master), Number(card==='JK'), Number(hasTrump), rank/12, Math.min(4,higherInSuit)/4,
      Number(!higherInSuit), Number(!canOvertake), Math.min(6,canOvertake)/6, Number(move.jokerCall===true),
      Number(card[0]===lead), Number(others.some(c=>c[0]===card[0])), Number(others.includes(master)),
      Number(others.includes('JK')), others.filter(c=>c[0]===trump).length/3,
      Number(others.some(c=>c[0]===(move.suit??card[0])))];
    return {move, features:context.flatMap(c=>vector.map(x=>x*c))};
  });
}

export function isEndgameChoice(view) {
  return view.phase==='play' && view.trickNo>=7 && view.trickNo<=9 && view.choices.plays.length>1;
}

export function chooseEndgame(view, original, model) {
  const options=endgameOptions(view);
  const score=row=>row.features.reduce((sum,x,i)=>sum+x*model.weights[i],0);
  const base=options.find(r=>r.move.card===original.card && r.move.suit===original.suit && !!r.move.jokerCall===!!original.jokerCall);
  let chosen=original, best=score(base)+model.margin;
  for(const option of options) {
    const value=score(option);
    if(value>best) {best=value; chosen={type:'play',...option.move};}
  }
  return chosen;
}
