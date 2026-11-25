import {leadSuit, mighty, pointsIn} from '../engine.js';
import {protectPartner} from './partnership-policy.js';
import {searchAction} from './search-policy.js';

// Compute before search, from the acting seat's own cards and the public trick.
export function searchGateFeatures(view, action) {
  const trump=view.bid.suit, master=mighty(trump), declarer=Number(view.seat===view.declarer);
  const lead=Number(!view.trick.length), last=Number(view.trick.length===4);
  const remaining=(10-view.trickNo)/9, count=Math.min(12,view.choices.plays.length)/12;
  const trumps=view.hand.filter(c=>c[0]===trump).length/8;
  const special=Number(action.card===master || action.card==='JK');
  return [1,declarer,Number(view.selfRole==='friend'),Number(view.friendKnown),lead,last,
    remaining,count,trumps,Number(view.hand.includes(master)),Number(view.hand.includes('JK')),
    special,Number(action.card[0]===trump),Number(pointsIn([action.card])>0),
    pointsIn(view.trick.map(p=>p.card))/4,Number(leadSuit(view.trick)===trump),
    declarer*lead,declarer*remaining,remaining*lead,remaining*count];
}

export function searchGateScore(weights, features) {
  return weights.reduce((score,weight,i)=>score+weight*features[i],0);
}

export function searchTeacher(view) {
  return searchAction(protectPartner(view));
}

export function gatedPlay(gate, view, action) {
  if (view.choices.plays.length<2) return action;
  return searchGateScore(gate.weights,searchGateFeatures(view,action)) >= gate.threshold
    ? searchTeacher(view) : action;
}
