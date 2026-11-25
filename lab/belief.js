// A proposal over whole deals. Voids/capacities prune draws; only an engine replay
// that reconstructs the requesting seat's private and public history is accepted.
import {applyAction, botObservation, createGame, DECK, leadSuit, mighty, pointsIn, sortHand} from '../engine.js';
import {rngFor} from './game.js';

const clone = value => structuredClone(value);
const sum = values => values.reduce((a,b) => a + b, 0);
const stages = v => [...v.playedTricks.map(t => t.cards), v.trick];
const ownerCount = 6;

// Model features only use an unknown card, a candidate destination and root observations.
// Bids are evidence about strength. An unplayed called card can legally be in the burial.
function features(v, card, owner) {
  const kitty = owner === 5;
  const declarer = owner === v.declarer;
  const trump = card[0] === v.bid.suit;
  const special = card === mighty(v.bid.suit) || card === 'JK';
  const honor = pointsIn([card]);
  const ace = card.endsWith('A');
  const bids = v.bidHistory.filter(b => b.seat === owner && !b.pass);
  const suitedBid = bids.some(b => b.suit === card[0]);
  return [Number(kitty), Number(declarer), Number(kitty && trump), Number(kitty && special),
    Number(kitty && honor), Number(kitty && ace), Number(declarer && trump), Number(declarer && special),
    Number(declarer && honor), Number(suitedBid), Number(suitedBid && honor),
    Number((kitty || declarer) && v.call?.card === card)];
}

export function unknownCards(v) {
  const seen = new Set([...v.hand, ...v.discarded, ...stages(v).flat().map(p => p.card)]);
  return DECK.filter(c => !seen.has(c));
}

export function ownershipRows(v, model) {
  if (!['play','friend'].includes(v.phase) || v.turn !== v.seat || !Array.isArray(v.playedTricks))
    throw Error('A card-play or friend-declaration botObservation with complete public history is required.');
  if (v.seat === v.declarer && (v.knownKitty?.length !== 3 || v.discarded?.length !== 3))
    throw Error('The declarer observation must include their original kitty and discard.');
  if (model && (model.schema !== 'mighty-ownership-linear-v1' || model.weights?.length !== 12 ||
    model.weights.some(w => !Number.isFinite(w)))) throw Error('Unsupported belief model.');
  const spaces = [...v.counts.map((n,i) => i === v.seat ? 0 : n), v.seat === v.declarer ? 0 : 3];
  const voids = Array.from({length:5}, () => new Set());
  const cannotHoldJoker = new Set();
  const master = mighty(v.bid.suit);
  const first = stages(v)[0]?.[0];
  for (const trick of stages(v)) {
    for (let j=1; j<trick.length; j++) {
      const p = trick[j], lead = leadSuit(trick.slice(0,j));
      if (p.card === master || p.card === 'JK') continue;
      if (lead && p.card[0] !== lead) voids[p.seat].add(lead);
      if (trick[0].jokerCall) cannotHoldJoker.add(p.seat);
    }
  }
  const rows = unknownCards(v).map(card => {
    const dest = [];
    for (let owner=0; owner<ownerCount; owner++) {
      if (!spaces[owner]) continue;
      if (owner < 5 && (voids[owner].has(card[0]) || (card === 'JK' && cannotHoldJoker.has(owner)))) continue;
      if (owner === first?.seat && first.card[0] === v.bid.suit && card[0] !== v.bid.suit) continue;
      const x = features(v,card,owner);
      const logWeight = model ? sum(x.map((value,i) => model.weights[i]*value)) : 0;
      dest.push({owner,x,weight:Math.exp(Math.max(-9,Math.min(9,logWeight)))});
    }
    return {card,dest};
  });
  if (rows.length !== sum(spaces)) throw Error('Hand capacities and public history disagree.');
  return {rows,spaces};
}

function drawHands(v, rows, spaces, rng) {
  const remaining = [...spaces], hands = Array.from({length:ownerCount}, () => []);
  hands[v.seat] = [...v.hand];
  if (v.seat === v.declarer) hands[5] = [...v.discarded];
  const ordered = rows.map(row => ({...row,tie:rng()})).sort((a,b) =>
    a.dest.length-b.dest.length || a.tie-b.tie);
  for (const {card,dest} of ordered) {
    const weights = dest.map(({owner,weight}) => remaining[owner]*weight);
    const total = sum(weights);
    if (!total) return null;
    let cutoff = rng()*total;
    const i = weights.findIndex(w => (cutoff -= w) < 0);
    const owner = dest[i].owner;
    hands[owner].push(card);
    remaining[owner]--;
  }
  return hands;
}

function reconstruct(v, draw, rng, withHistory) {
  const opening = draw.slice(0,5).map(h => [...h]);
  const buried = draw[5];
  const allPlays = stages(v).flat();
  for (const p of allPlays) opening[p.seat].push(p.card);
  const thirteen = [...opening[v.declarer], ...buried];
  const bag = [...thirteen];
  const kitty = v.seat === v.declarer ? [...v.knownKitty]
    : Array.from({length:3}, () => bag.splice(Math.floor(rng()*bag.length),1)[0]);
  if (!kitty.every(c => thirteen.includes(c)) || new Set(kitty).size !== 3) return null;
  opening[v.declarer] = thirteen.filter(c => !kitty.includes(c));
  if (opening.some(h => h.length !== 10 || !pointsIn(h))) return null;
  const firstSeat = v.bidHistory[0].seat;
  // The constructor initializes counters. All shuffled cards are replaced *before* the first observation.
  const state = createGame({firstSeat,rules:v.rules,random:rngFor(17)});
  Object.assign(state,{hands:opening.map(sortHand), kitty, dealNo:v.dealNo});
  const histories = Array.from({length:5}, () => []);
  function step(seat, action) {
    if (withHistory) histories[seat].push({observation:botObservation(state,seat),action:clone(action)});
    applyAction(state, seat, action);
  }
  try {
    for (const b of v.bidHistory) {
      step(b.seat,b.pass ? {type:'pass'} : {type:'bid',points:b.points,suit:b.suit});
      if (b.name !== undefined) state.bidHistory.at(-1).name = b.name;
    }
    step(v.declarer,{type:'discard',cards:buried,contract:v.bid});
    if (v.phase==='play') step(v.declarer,{type:'friend',...v.call});
    for (const {seat,...move} of allPlays) step(seat,{type:'play',...move});
  } catch { return null; }
  const obs = botObservation(state,v.seat);
  // Engine-generated arrays have a fixed hand/legal-action order. Compare every
  // engine observation field (additional caller metadata such as a display name is irrelevant).
  if (Object.keys(obs).some(key => JSON.stringify(obs[key]) !== JSON.stringify(v[key]))) return null;
  return {state,histories};
}

export function worldSampler(v, {model=null,seed=1,withHistory=false}={}) {
  const {rows,spaces} = ownershipRows(v,model), rng = rngFor(seed);
  const stats = {attempts:0,accepted:0,assignmentRejected:0,replayRejected:0,exhausted:0};
  function sample(maxAttempts=120) {
    for (let i=0; i<maxAttempts; i++) {
      stats.attempts++;
      const draw = drawHands(v,rows,spaces,rng);
      if (!draw) { stats.assignmentRejected++; continue; }
      const world = reconstruct(v,draw,rng,withHistory);
      if (!world) { stats.replayRejected++; continue; }
      stats.accepted++;
      return world;
    }
    stats.exhausted++;
    return null;
  }
  return {sample,stats};
}
