// Isolated auction experiment. The five other phases and every real card play use the frozen search bot.
import {applyAction, baselineDiscard, baselinePlay, botDecision, createGame, getView, mighty} from '../engine.js';
import {rngFor} from './game.js';
import {outcomes} from './scoring.js';
import {ruleAction} from './rules-agents.js';

const suits=['S','H','D','C'];
const rankOrder=['A','K','Q','J','10','9','8','7','6','5','4','3','2'];
const deck=[...suits.flatMap(s=>rankOrder.map(r=>s+r)),'JK'];
const order=new Map(deck.map((c,i)=>[c,i]));

function controls(hand,trump) {
  const holds=c=>hand.includes(c);
  const master=mighty(trump);
  const trumps=hand.filter(c=>c[0]===trump).length;
  let strength=10.3+1.7*holds('JK')+1.7*holds(master)+.72*Math.max(0,trumps-2);
  for(const suit of suits) {
    const count=hand.filter(c=>c[0]===suit).length;
    if(suit===trump){
      strength+=1.3*holds(suit+'A')+.85*holds(suit+'K')+.5*holds(suit+'Q');
      continue;
    }
    const ace=suit+'A';
    if(ace!==master) strength+=1.05*holds(ace);
    strength+=holds(suit+'K')*(holds(ace)?.78:count>1?.46:.19);
    if(trump!=='N' && trumps>=3) strength+=count===0?.76:count===1?.35:0;
  }
  if(trump==='N') strength-=1.15;
  return strength;
}

function shortlist(view,reference) {
  const bids=[...suits,'N'].map(suit=>view.choices.bids.find(b=>b.suit===suit)).filter(Boolean)
    .map(b=>({bid:{type:'bid',...b},margin:controls(view.hand,b.suit)-b.points})).sort((a,b)=>b.margin-a.margin);
  const best=bids[0];
  const threshold=view.bid ? .55+.18*Math.max(0,view.bid.points-14) : -.15;
  const analytic=best && best.margin>=threshold ? best.bid : {type:'pass'};
  const options=[reference,{type:'pass'},analytic];
  // A second suit or no-trump is useful only when own controls plausibly sustain the contract.
  for(const entry of bids.slice(0,2)) if(entry.margin>=-1.4) options.push(entry.bid);
  const unique=new Map(options.map(a=>[a.type+(a.suit??''),a]));
  return {analytic,options:[...unique.values()]};
}

function visibleSeed(v) {
  let hash=2166136261;
  for(const c of [v.seat,v.dealNo,...v.hand,...v.bidHistory.map(b=>b.seat+(b.suit??'P')+(b.points??''))].join('|')) {
    hash=Math.imul(hash^c.charCodeAt(0),16777619);
  }
  return hash>>>0;
}

function world(v,random) {
  const own=new Set(v.hand);
  const unseen=deck.filter(c=>!own.has(c));
  for(let i=unseen.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[unseen[i],unseen[j]]=[unseen[j],unseen[i]];}
  const state=createGame({rules:v.rules,firstSeat:v.bidHistory[0]?.seat??v.seat,random});
  state.hands=Array.from({length:5},(_,i)=>i===v.seat?[...v.hand]:unseen.splice(0,10).sort((a,b)=>order.get(a)-order.get(b)));
  state.kitty=unseen;
  state.turn=v.seat;state.dealNo=v.dealNo;state.bid=v.bid;state.bidHistory=v.bidHistory.slice();state.passed=v.passed.slice();
  return state;
}

function rollout(initial,choice,seat,seed) {
  const state=structuredClone(initial), random=rngFor(seed);
  applyAction(state,state.turn,choice,random);
  while(!state.result) {
    const s=state.turn, v=getView(state,s);
    let action;
    if(v.phase==='bid' && s!==seat) {
      // Continuations react to the auction in each world using only this seat's legal observation.
      action=ruleAction(['conservative','aggressive','heuristic'][(seed+s)%3],v,random);
    } else action=botDecision(v,baselinePlay,baselineDiscard);
    applyAction(state,s,action,random);
  }
  return outcomes(state)[seat];
}

export function hybridAction(mode,view) {
  if(!['controls','auction_win','auction_score'].includes(mode)) throw new Error('Unknown experimental policy');
  const reference=botDecision(view);
  if(view.phase!=='bid')return reference;
  const {analytic,options}=shortlist(view,reference);
  if(mode==='controls')return analytic;
  if(options.length===1)return options[0];
  const stream=rngFor(visibleSeed(view)), sums=options.map(()=>0);
  for(let sample=0;sample<8;sample++){
    const state=world(view,stream);
    const seed=Math.floor(stream()*4294967296);
    // Public live bids softly reweight hypothetical opponent holdings, without ruling out bluffs.
    const weight=state.bid?Math.max(.25,Math.min(2,1+.19*(controls(state.hands[state.bid.seat],state.bid.suit)-state.bid.points))):1;
    for(const [i,option] of options.entries()){
      const result=rollout(state,option,view.seat,seed);
      sums[i]+=weight*(mode==='auction_win'?result.win:result.settlement);
    }
  }
  // The incumbent wins ties and near-ties under the finite rollout budget.
  sums[0]+=mode==='auction_win'?.65:5;
  return options[sums.indexOf(Math.max(...sums))];
}
