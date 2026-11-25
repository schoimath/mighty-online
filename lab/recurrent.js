import {mighty} from '../engine.js';
import {protectPartner} from './partnership-policy.js';
import {ACTION_SIZE, decisionGroup, INPUT_SIZE} from './policy.js';

export const objectives = ['win','score','balanced'];
const suits = ['S','H','D','C','N'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const deck = [...suits.slice(0,4).flatMap(s => ranks.map(r => s+r)), 'JK'];
export const recurrentSchema = 'mighty-seat-gru-1';
export const inputSize = INPUT_SIZE + 4 + 10 + 35 + 3 + 53 + 4 * 4 + 5;
export {ACTION_SIZE as actionSize};

// Every feature can be computed at the table by the seat taking the decision.
export function recurrentGroup(view, contract) {
  const group = decisionGroup(view, contract);
  const seatFlag = seat => Array.from({length:5}, (_,i) => Number(seat === (i+view.seat)%5));
  const recentBids = [];
  for (let i=0; i<5; i++) {
    const last = view.bidHistory.findLast(b => b.seat === (i+view.seat)%5);
    recentBids.push(...suits.map(s=>Number(last?.suit===s)), (last?.points??0)/20, Number(Boolean(last?.pass)));
  }
  const trick = [];
  for (let i=0;i<4;i++) {
    const p=view.trick[i];
    trick.push(p ? ((p.seat-view.seat+5)%5+1)/5 : 0, p ? (deck.indexOf(p.card)+1)/53 : 0,
      p ? (suits.indexOf(p.suit)+1)/5 : 0, Number(Boolean(p?.jokerCall)));
  }
  const {rules}=view;
  group.state = group.state.concat([rules.minBid/20,+rules.allowFirstFriend,+rules.allowFirstJokerCall,+rules.allowLastJoker],
    seatFlag(view.declarer),seatFlag(view.friend),recentBids,
    ['card','first','none'].map(kind => Number(view.call?.kind===kind)),
    deck.map(card => Number(view.call?.card===card)),trick,seatFlag(view.lastTrick?.winner));
  if (view.phase==='play') {
    const master=mighty(view.bid.suit);
    const protectMaster=protectPartner(view)!==view;
    const spareJoker=view.trickNo < (rules.allowLastJoker ? 10 : 9) &&
      (view.trickNo===1 || view.trick.some(p=>p.card===master)) && !view.trick[0]?.jokerCall &&
      group.choices.some(p=>p.card!=='JK' && p.card!==master);
    group.priors=group.priors.map((prior,i)=>{
      const {card}=group.choices[i];
      return prior-((card===master && protectMaster) || (card==='JK' && spareJoker) ? 14 : 0);
    });
  }
  return group;
}

function dot(row,input) {
  let total=0;
  for(let i=0;i<row.length;i++) total+=row[i]*input[i];
  return total;
}
const sigmoid=n=>1/(1+Math.exp(-n));

export function recurrentDistribution(model,group,previousHidden,objective) {
  const z=objectives.indexOf(objective);
  if (z<0 || model.schema!==recurrentSchema) throw Error('Unknown GRU schema or objective');
  const old=previousHidden??Array(model.hidden).fill(0);
  const x=group.state.concat(objectives.map((_,i)=>Number(i===z)));
  const input=model.input.map((row,i)=>dot(row,x)+model.inputBias[i]);
  const hiddenGates=model.recurrent.map((row,i)=>dot(row,old)+model.recurrentBias[i]);
  const hidden=Array.from({length:model.hidden},(_,i)=>{
    const update=i+model.hidden, candidate=update+model.hidden;
    const r=sigmoid(input[i]+hiddenGates[i]), u=sigmoid(input[update]+hiddenGates[update]);
    return (1-u)*Math.tanh(input[candidate]+r*hiddenGates[candidate])+u*old[i];
  });
  const preference=model.actor.map((row,i)=>dot(row,hidden)+model.actorBias[i]);
  const logits=group.features.map((f,i)=>group.priors[i]+dot(f,preference));
  const max=Math.max(...logits), weights=logits.map(l=>Math.exp(l-max));
  const sum=weights.reduce((a,b)=>a+b,0);
  if (!(sum>0 && Number.isFinite(sum))) throw Error('Nonfinite GRU distribution');
  return {hidden,logits,probs:weights.map(w=>w/sum),value:dot(model.critic,hidden)+model.criticBias};
}

export function createRecurrentPolicy(model, objective, {sample=false,record}={}) {
  let memory=null, deal=null;
  const policy=(view,rng=Math.random)=>{
    if (deal!==null && deal!==view.dealNo) memory=null;
    deal=view.dealNo;
    function choose(group) {
      const reset=memory===null;
      const {probs,hidden,value}=recurrentDistribution(model,group,memory,objective);
      memory=hidden;
      let index=0;
      if (sample) {
        let t=rng();
        while(index+1<probs.length && (t-=probs[index])>0) index++;
      } else for(let i=1;i<probs.length;i++) if(probs[i]>probs[index]) index=i;
      if (record) record({state:group.state,features:group.features,priors:group.priors,
        index,logp:Math.log(probs[index]),value,reset,objective});
      return group.choices[index];
    }
    const first=choose(recurrentGroup(view));
    return view.phase==='discard' ? choose(recurrentGroup(view,first)) : first;
  };
  policy.getMemory=()=>memory?.slice()??null;
  policy.restoreMemory=previous=>{
    if(previous!=null && (!Array.isArray(previous) || previous.length!==model.hidden || !previous.every(Number.isFinite))) {
      throw Error('Invalid seat GRU memory');
    }
    memory=previous?.slice()??null;
    deal=null;
  };
  return policy;
}

export function replayRecurrentMemory(model,objective,history) {
  let memory=null, deal=null;
  for (const entry of history) {
    const view=entry.observation??entry;
    if(deal!==view.dealNo) memory=null;
    deal=view.dealNo;
    memory=recurrentDistribution(model,recurrentGroup(view),memory,objective).hidden;
    if(view.phase==='discard') {
      const contract=entry.action?.contract??view.bid;
      memory=recurrentDistribution(model,recurrentGroup(view,contract),memory,objective).hidden;
    }
  }
  return memory;
}
