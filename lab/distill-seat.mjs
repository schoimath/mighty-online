// Distil the table search teacher into the existing seat GRU's action head.
// Training and teacher-agreement validation use disjoint, deterministic deals.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {parseArgs} from 'node:util';
import {botDecision, policyPlay} from '../engine.js';
import {withJokerStatus} from '../table-joker.js';
import {conserveMightyOnTrumpAce, conserveOpeningJoker} from '../table-tactics.js';
import {preferTrumpLead} from '../table-trump-lead.js';
import {rngFor} from './game.js';
import {playLiveEpisode} from './live-game.js';
import {contractSearchAction} from './contract-search.js';
import {recurrentGroup, recurrentDistribution} from './recurrent.js';

const {values: args} = parseArgs({options: {
  model: {type:'string', default:'lab/artifacts/recurrent-aux/best-balanced.json'},
  out: {type:'string'}, train: {type:'string', default:'320'}, validation: {type:'string', default:'64'},
  seed: {type:'string', default:'32100000'}, 'validation-seed': {type:'string', default:'32300000'}
}});
if (!args.out) throw Error('Pass --out with an experiment directory.');
const out = resolve(args.out), model = JSON.parse(readFileSync(args.model));
const trainSeed = Number(args.seed), validationSeed = Number(args['validation-seed']);
const n = Number(args.train), v = Number(args.validation);
if (![n,v,trainSeed,validationSeed].every(Number.isSafeInteger) || n < 1 || v < 1 ||
    Math.max(trainSeed, validationSeed) < Math.min(trainSeed+n, validationSeed+v)) throw Error('Invalid deal split');
mkdirSync(out, {recursive:true});

function matches(a,b) {
  if (a.cards) return b.cards && a.cards.length===b.cards.length && a.cards.every(c=>b.cards.includes(c));
  return ['type','suit','points','kind','card'].every(k=>a[k]===b[k]) && !!a.jokerCall===!!b.jokerCall;
}

function collect(count, seed) {
  const examples=[];
  for (let game=0; game<count; game++) {
    const policies = Array.from({length:5}, (_,seat)=>{
      let hidden=null, deal=null;
      return (original,rng)=>{
        const view=conserveMightyOnTrumpAce(conserveOpeningJoker(withJokerStatus(original)));
        // Include a rotating seat and every declarer's plays. Other seats follow
        // the inexpensive table play prior so the teacher sees varied histories.
        const focal=seat===game%5 || seat===view.declarer;
        if(deal!==view.dealNo) { hidden=null; deal=view.dealNo; }
        if(!focal && view.phase!=='bid') return preferTrumpLead(original,botDecision(view,policyPlay));
        const action=focal ? preferTrumpLead(original,contractSearchAction(view,rng)) : botDecision(view,policyPlay);
        function record(group, target, phase) {
          const decision=recurrentDistribution(model,group,hidden,'balanced');
          hidden=decision.hidden;
          if(!focal || group.features.length<2) return;
          const index=group.choices.findIndex(c=>matches(c,target));
          if(index<0) throw Error('Teacher move outside '+phase+' mask '+JSON.stringify(target));
          examples.push({features:group.features, logits:decision.logits, hidden, index, phase});
        }
        if(view.phase==='discard') {
          const contract=action.contract??view.bid;
          record(recurrentGroup(view),{points:contract.points,suit:contract.suit},'contract');
          record(recurrentGroup(view,contract),action,'discard');
        } else record(recurrentGroup(view),action,view.phase);
        return action;
      };
    });
    playLiveEpisode({seed:seed+game,firstSeat:Math.floor(game/5)%5,policies});
    if ((game+1)%32===0) console.error(`seed ${seed}: ${game+1}/${count} deals, ${examples.length} labels`);
  }
  return examples;
}

// Keep the recurrent representation, priors, value estimator and all legal
// masks fixed. A multinomial logistic regression learns residual actor weights.
const train=collect(n,trainSeed), validation=collect(v,validationSeed);
const width=model.hidden+1, size=width*model.actor.length;
const delta=new Float64Array(size), first=new Float64Array(size), second=new Float64Array(size);
const random=rngFor(trainSeed), order=train.map((_,i)=>i);
function prediction(row) {
  const pref=new Float64Array(model.actor.length);
  for (let a=0;a<pref.length;a++) {
    const off=a*width;
    pref[a]=delta[off+model.hidden];
    for(let i=0;i<model.hidden;i++) pref[a]+=delta[off+i]*row.hidden[i];
  }
  const probs=row.logits.map((l,i)=>{
    const f=row.features[i];
    for(let a=0;a<f.length;a++) l+=f[a]*pref[a];
    return l;
  });
  const max=Math.max(...probs);
  let sum=0;
  for(let j=0;j<probs.length;j++) sum+=probs[j]=Math.exp(probs[j]-max);
  for(let j=0;j<probs.length;j++) probs[j]/=sum;
  return probs;
}
function assess(rows) {
  const summary={};
  for(const row of rows) {
    const s=summary[row.phase]??={n:0,agree:0,nll:0};
    const p=prediction(row);
    s.n++; s.agree+=Number(p.indexOf(Math.max(...p))===row.index);
    s.nll-=Math.log(Math.max(1e-30,p[row.index]));
  }
  for(const s of Object.values(summary)) {s.agree/=s.n; s.nll/=s.n;}
  return summary;
}
function save(name) {
  const result=structuredClone(model);
  for(let a=0;a<model.actor.length;a++) {
    result.actorBias[a]+=delta[a*width+model.hidden];
    for(let i=0;i<model.hidden;i++) result.actor[a][i]+=delta[a*width+i];
  }
  writeFileSync(join(out,name),JSON.stringify(result));
}
const epochs=[{epoch:0,validation:assess(validation)}];
let best=Infinity, step=0, selected=0;
for(let epoch=1;epoch<=12;epoch++) {
  for(let i=order.length-1;i>0;i--) {const j=Math.floor(random()*(i+1)); [order[i],order[j]]=[order[j],order[i]];}
  for(let start=0;start<order.length;start+=48) {
    const grad=new Float64Array(size), end=Math.min(order.length,start+48);
    for(let idx=start;idx<end;idx++) {
      const row=train[order[idx]], p=prediction(row), df=new Float64Array(model.actor.length);
      p[row.index]-=1;
      for(let j=0;j<p.length;j++) for(let a=0;a<df.length;a++) df[a]+=row.features[j][a]*p[j];
      for(let a=0;a<df.length;a++) {
        grad[a*width+model.hidden]+=df[a];
        for(let i=0;i<model.hidden;i++) grad[a*width+i]+=df[a]*row.hidden[i];
      }
    }
    step++;
    for(let i=0;i<size;i++) {
      const g=grad[i]/(end-start)+.0015*delta[i];
      first[i]=.9*first[i]+.1*g; second[i]=.999*second[i]+.001*g*g;
      delta[i]-=.014*(first[i]/(1-.9**step))/(Math.sqrt(second[i]/(1-.999**step))+1e-8);
    }
  }
  const scores=assess(validation);
  const loss=Object.values(scores).reduce((s,p)=>s+p.n*p.nll,0)/validation.length;
  epochs.push({epoch,validation:scores,loss});
  if(loss<best) {best=loss; selected=epoch; save('candidate.json');}
}
const report={method:'search-teacher-fixed-gru-actor',trainSeed,validationSeed,trainDeals:n,validationDeals:v,
  trainLabels:train.length,validationLabels:validation.length,selected,epochs};
writeFileSync(join(out,'training.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({trainLabels:train.length, validationLabels:validation.length, selected,
  before:epochs[0].validation,after:epochs[selected].validation}));
