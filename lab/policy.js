// Portable inference. Candidates are built exclusively from a seat's observation.
import {botDecision, leadSuit, mighty, policyPlay, ratedPlays} from '../engine.js';
import {champions} from './champions.js';

export const POLICY_SCHEMA = 'public-residual-mlp-v1';
const suits = ['S','H','D','C'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const deck = [...suits.flatMap(s => ranks.map(r => s+r)), 'JK'];
const cardIndex = new Map(deck.map((c,i) => [c,i]));
const rank = card => card === 'JK' ? 13 : ranks.indexOf(card.slice(1));
const honor = card => card !== 'JK' && rank(card) >= 8;
const indicator = (values, value) => values.map(v => Number(v === value));
const phases = ['bid','contract','discard','friend','play'];
const dot = (a,b) => {let sum=0; for(let i=0;i<a.length;i++) sum += a[i]*b[i]; return sum;};
const bound = (v,limit=5) => Math.max(-limit,Math.min(limit,v));
const lengthsOf = (hand,suit) => hand.filter(card=>card[0]===suit).length;
export const STATE_SIZE = 5+5+4+7+4+4+5+5+53+53;
export const ACTION_SIZE = 5+5+15;

function stateVector(v, phase, trump) {
  const memory = new Array(53).fill(0);
  const hand = new Array(53).fill(0);
  const voids = new Array(4).fill(0);
  const handLengths = suits.map(s => lengthsOf(v.hand,s));
  const strength = suits.map(s => v.hand.filter(c=>c[0]===s).reduce((t,c)=>t+rank(c)/12,0)/10);
  const won = new Array(5).fill(0), points = new Array(5).fill(0);
  for (const c of v.hand) hand[cardIndex.get(c)] = 1;
  const record = plays => {
    const lead = leadSuit(plays);
    for (const p of plays) {
      const relativeSeat = (p.seat-v.seat+5)%5;
      memory[cardIndex.get(p.card)] = (relativeSeat+1)/5;
      if (lead && p.card[0]!==lead && p.card!=='JK' && p.card!==mighty(trump)) {
        voids[suits.indexOf(lead)] |= 1 << relativeSeat;
      }
    }
  };
  for(const trick of v.playedTricks || []) {
    record(trick.cards);
    const rel=(trick.winner-v.seat+5)%5;
    won[rel] += .1;
    points[rel] += trick.cards.filter(p=>honor(p.card)).length/20;
  }
  record(v.trick);
  for(const c of v.discarded) memory[cardIndex.get(c)] = -1;
  return [...indicator(phases,phase),...indicator([...suits,'N'],trump),
    ...indicator(['declarer','friend','opposition','unknown'],v.selfRole),
    (v.bid?.points??0)/20,v.hand.length/13,v.trickNo/10,v.trick.length/4,
    v.bidHistory.length/12,+v.friendKnown, v.seat===v.declarer?1:0,
    ...handLengths.map(n=>n/10),...strength,...won,...points,...hand,...memory,
    ...voids.map(n=>n/31)];
}

export const INPUT_SIZE = STATE_SIZE + 4;
function group(v, phase, trump, choices, priors, teacher, optionFeatures) {
  if (!choices.length) throw Error('Empty legal '+phase+' mask');
  const features=choices.map((choice,i)=>{
    const extra=optionFeatures(choice);
    return [...indicator(phases,phase),...indicator([...suits,'N'],extra.suit),
      ...extra.numbers,...new Array(14-extra.numbers.length).fill(0),bound(priors[i])/5];
  });
  return {state:stateVector(v,phase,trump), features, priors, teacher, choices};
}

function bids(v, contract) {
  const choices=contract ? v.choices.contracts : [{type:'pass'},...v.choices.bids.map(b=>({type:'bid',...b}))];
  const expert=contract ? v.bid : botDecision(v,policyPlay);
  const teacher=choices.findIndex(c=>c.type==='pass'?expert.type==='pass':c.suit===expert.suit&&c.points===expert.points);
  function stats(c) {
    const long=lengthsOf(v.hand,c.suit);
    const masters=v.hand.filter(k=>k===mighty(c.suit)||k==='JK'||rank(k)>=11).length;
    const quality=c.suit==='N'?masters-3:Math.max(0,long-2);
    const ceiling=Math.min(20,10+masters+quality);
    return {long,masters,ceiling};
  }
  const priors=choices.map((c,i)=>{
    if(c.type==='pass')return expert.type==='pass'?2:.25;
    const {long,ceiling}=stats(c);
    if(contract) return bound(-1.5*(c.points-v.bid.points) + .22*(long-lengthsOf(v.hand,v.bid.suit)) + (i===teacher?.7:0));
    if (!v.bid && v.dealNo>1 && i===teacher) return 3;
    return bound(.6+ .26*long + .22*(ceiling-c.points) - 1.4*Math.max(0,c.points-ceiling)
      - .55*(c.points-(v.bid?.points??v.rules.minBid)) + (i===teacher?.35:0));
  });
  return group(v,contract?'contract':'bid',v.bid?.suit,choices,priors,Math.max(0,teacher),c=>{
    if(c.type==='pass') return {numbers:[1]};
    const {long,masters,ceiling}=stats(c);
    return {suit:c.suit,numbers:[0,c.points/20,long/10,masters/6,(ceiling-c.points)/8,+(c.suit===v.bid?.suit)]};
  });
}

function discards(v, contract) {
  const hand=v.hand, trump=contract.suit, master=mighty(trump);
  const expert=botDecision({...v,bid:{...v.bid,...contract}},policyPlay);
  const expertSet=new Set(expert.cards);
  const choices=[], priors=[], rows=[];
  let teacher=0;
  const lengths=suits.map(s=>lengthsOf(hand,s));
  for(let i=0;i<hand.length-2;i++)for(let j=i+1;j<hand.length-1;j++)for(let k=j+1;k<hand.length;k++){
    const cards=[hand[i],hand[j],hand[k]], trumps=lengthsOf(cards,trump);
    const specials=cards.filter(c=>c===master||c==='JK').length;
    const cost=cards.reduce((sum,c)=>sum+Math.pow(Math.max(0,rank(c))/12,3),0);
    const scored=cards.filter(honor).length;
    const voids=suits.reduce((sum,s,idx)=>sum+Number(trump!=='N'&&trump!==s&&lengths[idx]>0&&lengthsOf(cards,s)===lengths[idx]),0);
    const pick=cards.every(c=>expertSet.has(c));
    if(pick)teacher=choices.length;
    priors.push(-9*specials-4*trumps-1.8*cost+1.1*scored+.8*voids+(pick?.32:0));
    choices.push({type:'discard',cards,contract});
    rows.push({suit:trump,numbers:[scored/3,trumps/3,specials,cost/3,voids/3,
      ...suits.map(s=>lengthsOf(cards,s)/3),+pick]});
  }
  let index=0;
  return group(v,'discard',trump,choices,priors,teacher,()=>rows[index++]);
}

function calls(v) {
  const trump=v.bid.suit, master=mighty(trump), exp=botDecision(v,policyPlay);
  const choices=v.choices.friends.map(c=>({type:'friend',...c}));
  const teacher=choices.findIndex(a=>a.kind===exp.kind&&a.card===exp.card);
  function feat(c) {
    const own=c.card && (v.hand.includes(c.card)||v.discarded.includes(c.card));
    return {suit:c.card?.[0],numbers:[+(c.kind==='first'),+(c.kind==='none'),+(c.card===master),
      +(c.card==='JK'),+(c.card?.[0]===trump),+(own||false),c.card?rank(c.card)/13:0]};
  }
  const priors=choices.map((c,i)=>{
    const [first,none,boss,joker,tr,own,r] = feat(c).numbers;
    return own||none ? -3 : first ? .3 : 4.1*boss+3.4*joker+.65*tr+1.95*r*r + (i===teacher?.35:0);
  });
  return group(v,'friend',trump,choices,priors,teacher,feat);
}

function plays(v) {
  const rated=ratedPlays(v), trump=v.bid.suit, lead=leadSuit(v.trick);
  const choices=rated.map(r=>({type:'play',...r.move}));
  const priors=rated.map(r=>Math.max(-12,.85*(r.value-rated[0].value)));
  return group(v,'play',trump,choices,priors,0,c=>({suit:c.card[0],numbers:[
    rank(c.card)/13,+honor(c.card),+(c.card===mighty(trump)),+(c.card==='JK'),+(c.card[0]===trump),
    +(c.card[0]===lead),+(c.jokerCall||false),c.suit?lengthsOf(v.hand,c.suit)/10:0,
    lengthsOf(v.hand,c.card[0])/10,+(c.card===v.call?.card),
    ...suits.map(s=>+(c.suit===s))]}));
}

export function decisionGroup(v, contract) {
  switch(v.phase) {
    case 'bid': return bids(v,false);
    case 'discard': return contract ? discards(v,contract) : bids(v,true);
    case 'friend': return calls(v);
    case 'play': return plays(v);
    default: throw Error('No action in phase '+v.phase);
  }
}

export function distribution(m,g) {
  const h=m.context.map((r,j)=>Math.tanh(dot(r,g.state)+m.contextBias[j]));
  const preference=m.actor.map((r,j)=>dot(r,h)+m.actorBias[j]);
  const logits=g.features.map((r,i)=>g.priors[i]+dot(r,preference));
  const max=Math.max(...logits);
  const weights=logits.map(z=>Math.exp(z-max)), norm=weights.reduce((a,b)=>a+b,0);
  if(!(norm>0&&Number.isFinite(norm)))throw Error('Invalid policy distribution');
  return {probs:weights.map(w=>w/norm),value:dot(m.critic,h)+m.criticBias,logits};
}

export function decide(m,v,rng,record) {
  function choose(g) {
    const {probs,value}=distribution(m,g);
    let i=0;
    if(record) {let t=rng();while(i<probs.length-1 && (t-=probs[i])>0)i++;}
    else for(let j=1;j<probs.length;j++)if(probs[j]>probs[i])i=j;
    if(record)record({...g,index:i,logp:Math.log(probs[i]),value});
    return g.choices[i];
  }
  const action=choose(decisionGroup(v));
  return v.phase==='discard'?choose(decisionGroup(v,action)):action;
}
export function neuralAction(model,v,rng) {
  const m=typeof model==='string'?champions[model]:model;
  if(!m)throw Error('Unknown neural model '+model);
  return decide(m,v,rng);
}

