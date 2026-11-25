// One-action deviations with identical hidden cards and continuation policies.
// Only public seat features and the resulting utility differences leave a deal.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {isMainThread, parentPort, Worker, workerData} from 'node:worker_threads';
import {botObservation} from '../engine.js';
import {applyAction, createGame} from '../table-deal.js';
import {preferTrumpLead} from '../table-trump-lead.js';
import {rngFor} from './game.js';
import {liveOutcomes, liveUtility} from './live-game.js';
import {createRecurrentPolicy, recurrentDistribution, recurrentGroup} from './recurrent.js';
import {decideTableTurn} from './table-agents.js';

const id='recurrent_balanced', reward={alpha:.7,scoreScale:640};

function collect(seed, index, weights) {
  const random=rngFor(seed), sample=rngFor(seed ^ 0x48ace), focal=index%5;
  const state=createGame({random,firstSeat:Math.floor(index/5)%5});
  const lineup=[id, 'contract_search', 'heuristic', [id,'contract_search','heuristic'][index%3]];
  for(let k=3;k>0;k--){const j=Math.floor(sample()*(k+1));[lineup[k],lineup[j]]=[lineup[j],lineup[k]];}
  lineup.splice(focal,0,id);
  const memory=Array(5).fill(null), positions=[], examples=[];
  const reference=createRecurrentPolicy(weights,'balanced');
  const referenceTurn=(view,rng,previous)=>{
    reference.restoreMemory(previous);
    const action=reference(view,rng);
    return {action,memory:reference.getMemory()};
  };
  let tick=0, branches=0;
  function move(s, memo, t, inspect) {
    const seat=s.turn, view=botObservation(s,seat);
    const recurrentTurn=inspect ? (masked,rng,previous)=>{
      const group=recurrentGroup(masked);
      const distribution=recurrentDistribution(weights,group,previous,'balanced');
      const {hidden,logits}=distribution;
      const indices=logits.map((_,i)=>i).sort((a,b)=>logits[b]-logits[a]);
      const best=indices[0], actions=indices.filter(i=>logits[best]-logits[i]<4
        && preferTrumpLead(view,group.choices[i]).card===group.choices[i].card).slice(0,3);
      if(actions[0]===best && actions.length>1) {
        const nextMemo=memo.slice(); nextMemo[seat]=hidden;
        positions.push({state:structuredClone(s), memo:nextMemo, tick:t, seat, hidden, logits, actions,
          choices:group.choices, features:group.features, order:sample()});
      }
      return {action:group.choices[best], memory:hidden};
    } : referenceTurn;
    const decision=decideTableTurn({modelId:lineup[seat],view,memory:memo[seat],
      seed:(seed ^ Math.imul(t+1,0x9e3779b9) ^ Math.imul(seat+1,0x85ebca6b))>>>0},recurrentTurn);
    memo[seat]=decision.memory??null;
    const previous=s.dealNo;
    applyAction(s,seat,decision.action,random);
    if(s.dealNo!==previous) memo.fill(null);
  }
  while(!state.result){
    const inspect=lineup[state.turn]===id && state.phase==='play' && !(state.call.kind==='first' && state.friend==null);
    move(state,memory,tick++,inspect);
  }
  for(const p of positions.sort((a,b)=>a.order-b.order).slice(0,6)){
    const values=p.actions.map(i=>{
      const s=structuredClone(p.state), memo=p.memo.slice();
      applyAction(s,p.seat,p.choices[i]);
      for(let t=p.tick+1;!s.result;t++) move(s,memo,t,false);
      branches++;
      const result=liveOutcomes(s)[p.seat];
      const teamPoints=result.role==='opposition'?20-s.result.points:s.result.points;
      return [liveUtility(result,'balanced',reward),teamPoints];
    });
    for(let j=0;j<values.length;j++) for(let k=j+1;k<values.length;k++) {
      const a=p.actions[j], b=p.actions[k];
      examples.push({hidden:p.hidden, features:p.features[a].map((v,i)=>v-p.features[b][i]),
        logit:p.logits[a]-p.logits[b], utility:values[j][0]-values[k][0], points:values[j][1]-values[k][1]});
    }
  }
  return {seed,branches,examples};
}

if(isMainThread){
  const [weights, out, first, count, workers]=process.argv.slice(2);
  const n=Number(count), w=Number(workers), start=Number(first);
  if(!out || !weights || ![start,n,w].every(Number.isSafeInteger) || start<0 || n<1 || w<1) {
    throw Error('Use WEIGHTS OUTPUT FIRST_SEED NUMBER_OF_DEALS WORKERS');
  }
  mkdirSync(dirname(out), {recursive:true});
  const jobs=Math.min(w,n);
  const chunks=await Promise.all(Array.from({length:jobs},(_,k)=>new Promise((accept,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{weights,n,jobs,k,start}});
    worker.once('message',accept);worker.once('error',reject);
    worker.once('exit',code=>{if(code)reject(Error('Worker exit '+code));});
  })));
  const deals=chunks.flat().sort((a,b)=>a.seed-b.seed);
  writeFileSync(out,JSON.stringify(deals));
  console.log(JSON.stringify({deals:n,branches:deals.reduce((s,r)=>s+r.branches,0),pairs:deals.reduce((s,r)=>s+r.examples.length,0)}));
}else{
  const {weights,n,jobs,k,start}=workerData, model=JSON.parse(readFileSync(weights));
  const results=[];
  for(let i=k;i<n;i+=jobs) results.push(collect(start+i,i,model));
  parentPort.postMessage(results);
}
