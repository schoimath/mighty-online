// Fit a late-play action value from paired continuations of the same dealt hand.
import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {isMainThread, parentPort, Worker, workerData} from 'node:worker_threads';
import {botDecision, botObservation, policyPlay, baselinePlay} from '../engine.js';
import {createGame,applyAction} from '../table-deal.js';
import {conserveOpeningJoker,conserveMightyOnTrumpAce} from '../table-tactics.js';
import {withJokerStatus} from '../table-joker.js';
import {preferTrumpLead} from '../table-trump-lead.js';
import {rngFor} from './game.js';
import {liveOutcomes} from './live-game.js';
import {endgameOptions} from './endgame-policy.js';

const read = file => JSON.parse(readFileSync(file,'utf8'));
const viewFor = g => conserveMightyOnTrumpAce(conserveOpeningJoker(withJokerStatus(botObservation(g,g.turn))));
function move(v, style) {
  return preferTrumpLead(v, botDecision(v, style===0 ? baselinePlay : policyPlay));
}
function terminal(g, seat) {
  const outcome=liveOutcomes(g)[seat], attack=outcome.role!=='opposition';
  return (attack ? g.result.points : 20-g.result.points) + 4*outcome.win + outcome.settlement/12;
}
function finish(state,seat,play,styles) {
  const g=structuredClone(state);
  applyAction(g,seat,{type:'play',...play});
  while(!g.result) applyAction(g,g.turn,move(viewFor(g),styles[g.turn]));
  return terminal(g,seat);
}
function samples(start,count,k,jobs,collect) {
  let positions=0,pairs=0, width=0, gram, rhs;
  const rows=[];
  for(let i=k; i<count; i+=jobs) {
    const random=rngFor(start+i), g=createGame({random,firstSeat:i%5});
    const styles=Array.from({length:5},()=>Number(random()>.18));
    while(!g.result) {
      const v=viewFor(g), chosen=move(v,styles[g.turn]);
      if(v.phase==='play' && v.trickNo>=7 && v.trickNo<=9 && v.choices.plays.length>1) {
        const options=endgameOptions(v);
        const scores=options.map(o=>finish(g,g.turn,o.move,styles));
        const ref=options.findIndex(o=>o.move.card===chosen.card && o.move.suit===chosen.suit && !!o.move.jokerCall===!!chosen.jokerCall);
        if(ref<0) throw Error('Missing reference move');
        positions++;
        if(collect) {
          if(!width) {width=options[0].features.length; gram=new Float64Array(width*width); rhs=new Float64Array(width);}
          const anchor=options[ref].features;
          for(let j=0;j<options.length;j++) {
            if(j===ref) continue;
            const diff=options[j].features.map((x,a)=>x-anchor[a]);
            const y=scores[j]-scores[ref], weight=1/(options.length-1);
            for(let a=0;a<width;a++) {
              if(!diff[a]) continue;
              const x=weight*diff[a];
              rhs[a]+=x*y;
              for(let b=0;b<=a;b++) gram[a*width+b]+=x*diff[b];
            }
            pairs++;
          }
        } else rows.push({features:options.map(o=>o.features),scores,ref});
      }
      applyAction(g,g.turn,chosen,random);
      if(g.dealNo>100) throw Error('Redeal limit');
    }
  }
  return collect ? {positions,pairs,width,gram,rhs} : {positions,rows};
}

// Solve the positive-definite ridge normal equations by Cholesky factorization.
function fit(chunks, penalty) {
  const {width:n}=chunks[0], l=new Float64Array(n*n), y=new Float64Array(n), w=new Float64Array(n);
  for(let i=0;i<n;i++) {
    for(let j=0;j<=i;j++) {
      let s=chunks.reduce((sum,c)=>sum+c.gram[i*n+j],i===j ? penalty : 0);
      for(let k=0;k<j;k++) s-=l[i*n+k]*l[j*n+k];
      l[i*n+j]=i===j ? Math.sqrt(s) : s/l[j*n+j];
    }
    let s=chunks.reduce((sum,c)=>sum+c.rhs[i],0);
    for(let j=0;j<i;j++) s-=l[i*n+j]*y[j];
    y[i]=s/l[i*n+i];
  }
  for(let i=n-1;i>=0;i--) {
    let s=y[i];
    for(let j=i+1;j<n;j++) s-=l[j*n+i]*w[j];
    w[i]=s/l[i*n+i];
  }
  if(!w.every(Number.isFinite)) throw Error('Nonfinite endgame fit');
  return Array.from(w);
}
async function parallel(start,count,jobs,collect) {
  return Promise.all(Array.from({length:jobs},(_,k)=>new Promise((ok,fail)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{start,count,k,jobs,collect}});
    worker.once('message',ok); worker.once('error',fail);
    worker.once('exit',code=>{if(code) fail(Error('Training worker exit '+code));});
  })));
}
if(!isMainThread) {
  const {start,count,k,jobs,collect}=workerData;
  parentPort.postMessage(samples(start,count,k,jobs,collect));
} else {
  const [base,out,ns='2000',vs='240',workers='3']=process.argv.slice(2);
  const n=Number(ns), v=Number(vs), jobs=Number(workers);
  if(!base || !out || ![n,v,jobs].every(x=>Number.isSafeInteger(x) && x>0) || jobs>Math.min(n,v) || n>100000) throw Error('Use OLD.json OUT TRAIN_DEALS VALIDATION_DEALS WORKERS');
  mkdirSync(out,{recursive:true});
  if(readdirSync(out).length) throw Error('Choose an empty training directory');
  const trainingSeed=35200000, validationSeed=35400000;
  const chunks=await parallel(trainingSeed,n,jobs,true);
  const weights=fit(chunks,10);
  const positions=chunks.reduce((s,c)=>s+c.positions,0), pairs=chunks.reduce((s,c)=>s+c.pairs,0);
  console.log('Fitted '+positions+' positions / '+pairs+' counterfactual pairs');
  const validation=(await parallel(validationSeed,v,jobs,false)).flatMap(c=>c.rows);
  const margins=[0,.25,.5,1], scores=margins.map(margin=>({margin,changed:0,totalGain:0}));
  for(const row of validation) {
    const pred=row.features.map(f=>f.reduce((s,x,k)=>s+x*weights[k],0));
    const best=pred.indexOf(Math.max(...pred));
    for(const s of scores) if(pred[best]>pred[row.ref]+s.margin) {
      s.changed++; s.totalGain+=row.scores[best]-row.scores[row.ref];
    }
  }
  const selected=scores.reduce((best,s)=>s.totalGain>best.totalGain?s:best);
  const model=read(base);
  model.endgame={weights,margin:selected.margin};
  const report={trainingSeed,validationSeed,trainingDeals:n,validationDeals:v,positions,pairs,
    validationPositions:validation.length,scores,selectedMargin:selected.margin};
  writeFileSync(join(resolve(out),'candidate.json'),JSON.stringify(model));
  writeFileSync(join(resolve(out),'training.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}
