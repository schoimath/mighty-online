import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createGame, applyAction} from '../table-deal.js';
import {botObservation,DECK} from '../engine.js';
import {rngFor} from './game.js';
import {ruleAction} from './rules-agents.js';
import {ownershipRows,worldSampler} from './belief.js';

const actorIds = ['heuristic','aggressive','conservative','heuristic','random'];
export function position(seed,trick,{branch=false,withHistory=false,policies=actorIds}={}) {
  const rng = rngFor(seed);
  const state = createGame({firstSeat:seed%5,random:rng});
  const seats = Array.from({length:5}, (_,i) => rngFor(seed ^ Math.imul(i+2,0x9e3779b9)));
  const histories = seats.map(() => []);
  while (!state.result) {
    const seat = state.turn, obs = botObservation(state,seat);
    if (obs.phase==='play' && obs.trickNo >= trick && (!branch || obs.choices.plays.length>=2))
      return {observation:obs,state,histories};
    const action = ruleAction(policies[(seat+seed)%5],obs,seats[seat]);
    if (withHistory) histories[seat].push({observation:obs,action});
    const round = state.dealNo;
    applyAction(state,seat,action,rng);
    if (state.dealNo !== round) histories.forEach(h => h.splice(0));
  }
  return null;
}

function trueOwner(state, card) {
  const owner = state.hands.findIndex(hand => hand.includes(card));
  if (owner>=0) return owner;
  if (state.discarded.includes(card)) return 5;
  throw Error('Unknown training label');
}

export function trainBelief({trainDeals=320,epochs=4,seed=208000}={}) {
  const weights = new Array(12).fill(0), rows = [];
  for(let i=0; i<trainDeals; i++) {
    const {observation,state} = position(seed+i,1+i%9);
    const batch = ownershipRows(observation);
    for(const {card,dest} of batch.rows) rows.push({dest,spaces:batch.spaces,target:trueOwner(state,card)});
  }
  const rng = rngFor(seed);
  for (let epoch=0; epoch<epochs; epoch++) {
    for (let i=rows.length-1; i>0; i--) {
      const j=Math.floor(rng()*(i+1));
      [rows[i],rows[j]]=[rows[j],rows[i]];
    }
    for(const {dest,spaces,target} of rows) {
      const exp = dest.map(({owner,x}) => spaces[owner]*Math.exp(x.reduce((a,f,i)=>a+f*weights[i],0)));
      const z = exp.reduce((a,b)=>a+b,0);
      const rate=.025/(1+epoch);
      weights.forEach((w,i) => {
        const grad = dest.reduce((a,d,j)=>a+d.x[i]*(Number(d.owner===target)-exp[j]/z),0);
        weights[i] += rate*(grad-.001*w);
      });
    }
  }
  return {schema:'mighty-ownership-linear-v1',weights,trainDeals,epochs,seed,labelledCards:rows.length,
    policyPool:actorIds,rules:'live-five-player; zero-point opening redealt; default room rules'};
}

export function validateBelief(model,{deals=60,samples=32,seed=1605000}={}) {
  const metrics = [null,model].map(() => ({brierSum:0,cards:0,accepted:0,attempts:0,exhausted:0,excluded:0,invalidAccepted:0}));
  const paired=[];
  for(let i=0; i<deals; i++) {
    const {observation,state} = position(seed+i,1+i%9);
    const {rows} = ownershipRows(observation);
    const dealSums=[];
    for (const [index,prior] of [null,model].entries()) {
      const sampler = worldSampler(observation,{model:prior,seed:seed+i});
      const counts = rows.map(() => Array(6).fill(0));
      for(let n=0; n<samples; n++) {
        const world = sampler.sample();
        if (!world) continue;
        const sampled=world.state;
        const all=[...sampled.hands.flat(),...sampled.discarded,...sampled.trick.map(p=>p.card),
          ...sampled.playedTricks.flatMap(t=>t.cards.map(p=>p.card))];
        if (all.length!==DECK.length || new Set(all).size!==DECK.length ||
          JSON.stringify(botObservation(sampled,observation.seat))!==JSON.stringify(observation)) metrics[index].invalidAccepted++;
        rows.forEach(({card},j) => counts[j][trueOwner(sampled,card)]++);
      }
      const m=metrics[index], {accepted,attempts,exhausted}=sampler.stats;
      m.accepted+=accepted; m.attempts+=attempts; m.exhausted+=exhausted;
      if (!accepted) {m.excluded++; continue;}
      let sum=0;
      for (const [j,{card}] of rows.entries()) {
        const owner=trueOwner(state,card);
        sum += counts[j].reduce((s,count,k) => s+(count/accepted-Number(k===owner))**2,0);
        m.cards++;
      }
      m.brierSum+=sum;
      dealSums[index]=sum;
    }
    if(Number.isFinite(dealSums[0])&&Number.isFinite(dealSums[1])) paired.push({n:rows.length,diff:dealSums[1]-dealSums[0]});
  }
  const scores = metrics.map(({brierSum,cards,...m})=>({...m,scoredCards:cards,
    multiclassBrier:brierSum/cards,proposalRejection:1-m.accepted/m.attempts,
    invalidAcceptedRate:m.accepted ? m.invalidAccepted/m.accepted : null}));
  const bootstrap=[], rng=rngFor(seed^0x3f1a);
  for(let r=0; r<2000 && paired.length; r++){
    let n=0,diff=0;
    for(let i=0;i<paired.length;i++){
      const deal=paired[Math.floor(rng()*paired.length)];
      n+=deal.n;diff+=deal.diff;
    }
    bootstrap.push(diff/n);
  }
  bootstrap.sort((a,b)=>a-b);
  const percentile=p=>bootstrap[Math.floor(p*(bootstrap.length-1))];
  return {deals,samples,seed,uniformProposal:scores[0],learnedProposal:scores[1],
    pairedLearnedMinusUniform:{deals:paired.length,bootstrapReplicates:bootstrap.length,
      ci95:bootstrap.length?[percentile(.025),percentile(.975)]:null}};
}

export const saveJSON=(path,value) => {mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2)+'\n');};
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg=(key,def)=>process.argv.includes('--'+key)?process.argv[process.argv.indexOf('--'+key)+1]:def;
  const out=arg('out','lab/artifacts/belief');
  const model=trainBelief({trainDeals:Number(arg('train-deals',320))});
  saveJSON(out+'/ownership.json',model);
  writeFileSync(out+'/ownership.js','// Produced by lab/belief-experiment.mjs\nexport const ownershipModel = '+
    JSON.stringify(model,null,2)+';\n');
  const result=validateBelief(model,{deals:Number(arg('eval-deals',60)),samples:Number(arg('samples',32))});
  saveJSON(out+'/validation.json',result);
  console.log(JSON.stringify(result,null,2));
}
