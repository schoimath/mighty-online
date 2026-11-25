// Fit a public-information decision rule for spending search compute on a play.
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {baselinePlay,botDecision,botObservation,policyPlay} from '../engine.js';
import {createGame,applyAction} from '../table-deal.js';
import {withJokerStatus} from '../table-joker.js';
import {conserveMightyOnTrumpAce,conserveOpeningJoker} from '../table-tactics.js';
import {preferTrumpLead} from '../table-trump-lead.js';
import {rngFor} from './game.js';
import {liveOutcomes,liveUtility} from './live-game.js';
import {createRecurrentPolicy} from './recurrent.js';
import {searchGateFeatures,searchGateScore,searchTeacher} from './search-gate.js';

const guarded=view=>conserveMightyOnTrumpAce(conserveOpeningJoker(withJokerStatus(view)));
const same=(a,b)=>a.card===b.card && a.suit===b.suit && !!a.jokerCall===!!b.jokerCall;

// The two labels share the complete training deal and continuation policy. The
// hidden deal supplies terminal supervision only; none of it enters the gate.
function finish(state,seat,first,continuation) {
  const s=structuredClone(state);
  applyAction(s,seat,first);
  while(!s.result) {
    const v=guarded(botObservation(s,s.turn));
    applyAction(s,s.turn,preferTrumpLead(v,botDecision(v,continuation)));
  }
  const outcome=liveOutcomes(s)[seat];
  const sidePoints=outcome.role==='opposition'?20-s.result.points:s.result.points;
  return {utility:liveUtility(outcome,'balanced'), points:sidePoints};
}

function examples(index,seed,model) {
  const rng=rngFor(seed+index), state=createGame({random:rng,firstSeat:Math.floor(index/5)%5});
  const actors=Array.from({length:5},()=>createRecurrentPolicy(model,'balanced'));
  const focus=index%5, rows=[];
  while(!state.result) {
    const seat=state.turn, raw=botObservation(state,seat), view=guarded(raw);
    const monitored=seat===focus || seat===state.declarer;
    // Track every bidder's early GRU history in case that seat becomes declarer.
    const primary=monitored || view.phase==='bid' ? actors[seat](view,rng) : botDecision(view,policyPlay);
    let action=preferTrumpLead(raw,primary);
    if(monitored && view.phase==='play' && view.choices.plays.length>=2) {
      const teacher=preferTrumpLead(raw,searchTeacher(view));
      let utility=0, points=0;
      if(!same(action,teacher)) {
        const continuation=index%2?policyPlay:baselinePlay;
        const a=finish(state,seat,action,continuation), b=finish(state,seat,teacher,continuation);
        utility=b.utility-a.utility; points=b.points-a.points;
        // Collect along a fixed mixture of student and teacher trajectories.
        if(rng()<.5) action=teacher;
      }
      rows.push({x:searchGateFeatures(view,primary), utility, points});
    }
    applyAction(state,seat,action,rng);
  }
  return rows;
}

// Solve the ridge normal equations; the intercept is left unregularized.
function fit(rows) {
  const p=rows[0].x.length;
  const m=Array.from({length:p},()=>new Float64Array(p+1));
  for(const {x,utility,points} of rows) {
    const y=utility+.025*points;
    for(let i=0;i<p;i++) {
      for(let j=0;j<p;j++) m[i][j]+=x[i]*x[j];
      m[i][p]+=x[i]*y;
    }
  }
  for(let i=1;i<p;i++) m[i][i]+=8;
  for(let i=0;i<p;i++) {
    let best=i;
    for(let j=i+1;j<p;j++) if(Math.abs(m[j][i])>Math.abs(m[best][i])) best=j;
    [m[i],m[best]]=[m[best],m[i]];
    const pivot=m[i][i];
    if(Math.abs(pivot)<1e-10) throw Error('Singular feature matrix');
    for(let j=i;j<=p;j++) m[i][j]/=pivot;
    for(let k=0;k<p;k++) if(k!==i) {
      const scale=m[k][i];
      for(let j=i;j<=p;j++) m[k][j]-=scale*m[i][j];
    }
  }
  return m.map(r=>r[p]);
}

if(!isMainThread) {
  const {model,train,valid,workers,thread,trainSeed,validSeed}=workerData;
  const gather=(length,seed)=>{
    const rows=[];
    for(let i=thread;i<length;i+=workers) {
      rows.push(...examples(i,seed,model));
      if(thread===0 && i && i%(workers*32)===0) console.error(`${i}/${length} deals at seed ${seed}`);
    }
    return rows;
  };
  parentPort.postMessage([gather(train,trainSeed),gather(valid,validSeed)]);
} else {
  const [modelPath,destination,n='300',v='60',w='2',s='32410000',t='32450000',...extra]=process.argv.slice(2);
  if(!modelPath || !destination || extra.length)
    throw Error('Usage: node lab/train-search-gate.mjs MODEL NEW_OUT [TRAIN VALID WORKERS TRAIN_SEED VALID_SEED]');
  const train=Number(n),valid=Number(v),workers=Number(w),trainSeed=Number(s),validSeed=Number(t);
  if(![train,valid,workers].every(i=>Number.isSafeInteger(i) && i>0) || workers>Math.max(train,valid))
    throw Error('Deal and worker counts must be positive integers, with at most one worker per deal.');
  if(![trainSeed,validSeed].every(i=>Number.isSafeInteger(i) && i>=0) ||
      trainSeed+train>2**32 || validSeed+valid>2**32 ||
      Math.max(trainSeed,validSeed)<Math.min(trainSeed+train,validSeed+valid))
    throw Error('Training and validation need non-overlapping unsigned 32-bit deal seeds.');
  const out=resolve(destination);
  if(existsSync(out)) throw Error('Choose a new output directory. Path already exists: '+out);
  const modelBytes=readFileSync(modelPath);
  const model=JSON.parse(modelBytes);
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const fragments=await Promise.all(Array.from({length:workers},(_,thread)=>new Promise((yes,no)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{model,train,valid,workers,thread,trainSeed,validSeed}});
    worker.once('error',no); worker.once('message',yes);
    worker.once('exit',code=>{if(code)no(Error('worker exited '+code));});
  })));
  const [training,validation]=[0,1].map(k=>fragments.flatMap(pair=>pair[k]));
  const weights=fit(training), scores=training.map(r=>searchGateScore(weights,r.x)).sort((a,b)=>a-b);
  // Only use training-score quantiles for candidate thresholds. Select once
  // with held-out per-decision terminal gains; final tests use new full games.
  const choices=[.2,.35,.5,.6].map(budget=>{
    const threshold=scores[Math.floor((1-budget)*scores.length)];
    const accepted=validation.filter(r=>searchGateScore(weights,r.x)>=threshold);
    const sum=k=>accepted.reduce((total,r)=>total+r[k],0)/validation.length;
    return {budget,threshold,frequency:accepted.length/validation.length,meanUtilityGain:sum('utility'),
      meanSidePointsGain:sum('points')};
  });
  const best=choices.reduce((a,b)=>b.meanUtilityGain>a.meanUtilityGain?b:a);
  model.searchGate={weights,threshold:best.threshold};
  const candidate=JSON.stringify(model);
  const report={method:'paired-terminal-ridge-search-gate-v1',baseSha256:digest(modelBytes),candidateSha256:digest(candidate),
    trainSeed,validSeed,train,valid,trainingChoices:training.length,validationChoices:validation.length,
    choices,selected:best,workers,ridge:8,sidePointWeight:.025,searchGate:model.searchGate,nodeVersion:process.version,
    command:`node lab/train-search-gate.mjs <base-weights> <new-output> ${train} ${valid} ${workers} ${trainSeed} ${validSeed}`};
  // Publish weights and provenance together. If a concurrent run finishes
  // first, its nonempty output directory cannot be replaced by this rename.
  mkdirSync(dirname(out),{recursive:true});
  const staging=mkdtempSync(join(dirname(out),'.'+basename(out)+'-'));
  try {
    writeFileSync(join(staging,'candidate.json'),candidate);
    writeFileSync(join(staging,'training.json'),JSON.stringify(report,null,2)+'\n');
    renameSync(staging,out);
  } finally {
    if(existsSync(staging)) rmSync(staging,{recursive:true,force:true});
  }
  console.log(JSON.stringify(report));
}
