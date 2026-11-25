import {applyAction,botObservation} from '../engine.js';
import {ruleAction} from './rules-agents.js';
import {PARTNERSHIP_POLICY_VERSION,protectPartner} from './partnership-policy.js';
import {rngFor} from './game.js';
import {legalActionsFromObservation,liveOutcomes,liveUtility} from './live-game.js';
import {worldSampler} from './belief.js';

export const beliefBaseline = view => ruleAction('heuristic',protectPartner(view));
export const actionKey = a => a.kind ? ['friend',a.kind,a.card??''].join(':')
  : ['play',a.card,a.suit || '',a.jokerCall ? 'call':''].join(':');
export const heuristicContinuation = {id:'heuristic/engine.policyPlay/'+PARTNERSHIP_POLICY_VERSION,prepare:()=>()=>beliefBaseline};
const highest = xs => xs.indexOf(Math.max(...xs));
const mean = xs => xs.reduce((a,b)=>a+b,0)/xs.length;
export function summary(xs) {
  if (!xs.length) return {n:0,mean:null,se:null,ci95:null};
  const avg=mean(xs), n=xs.length;
  if(n===1) return {n,mean:avg,se:null,ci95:null};
  const se=Math.sqrt(xs.reduce((a,b)=>a+(b-avg)**2,0)/(n*(n-1)));
  // Conservative t quantile rounded up per degrees-of-freedom band.
  const df=n-1, t = df>=120 ? 1.981 : df>=60 ? 2.001 : df>=30 ? 2.043 : df>=20 ? 2.087 :
    df>=15 ? 2.132 : df>=10 ? 2.229 : df>=7 ? 2.365 : df>=5 ? 2.571 : df>=3 ? 3.183 : df===2 ? 4.303 : 12.707;
  return {n,mean:avg,se,ci95:[avg-t*se,avg+t*se]};
}

function compareWorlds(v, actions, objective, n, {model,seed,continuation,reward}) {
  const sampler=worldSampler(v,{model,seed,withHistory:!!continuation.needsHistory});
  const values=actions.map(()=>[]), crn=rngFor(seed^0x8d763b);
  for(let s=0;s<n;s++) {
    const world=sampler.sample();
    if (!world) continue;
    const prepareSeat=continuation.prepare(world.histories);
    const seeds=Array.from({length:5},()=>Math.floor(crn()*2**32));
    for(const [i,move] of actions.entries()) {
      const state=structuredClone(world.state);
      // Each branch gets independent memory copied from each seat's own sampled history.
      const actors=seeds.map((_,seat)=>prepareSeat(seat));
      const rngs=seeds.map(rngFor);
      if (continuation.commitRoot) continuation.commitRoot(actors[v.seat],v,move);
      applyAction(state,v.seat,move);
      while (!state.result) {
        const seat=state.turn;
        const a=actors[seat](botObservation(state,seat),rngs[seat]);
        applyAction(state,seat,a);
      }
      values[i].push(liveUtility(liveOutcomes(state)[v.seat],objective,reward));
    }
  }
  const stats=sampler.stats;
  return {values,stats:{...stats,proposalRejectionRate:stats.attempts ? 1-stats.accepted/stats.attempts : null,
    exhaustionRate:stats.exhausted/n,effectiveSampleSize:stats.accepted}};
}

export function pairedGain(returns,challenger,baseline) {
  const xs=returns[challenger], ys=returns[baseline];
  if(xs.length!==ys.length) throw Error('Paired actions require the same accepted worlds.');
  return summary(xs.map((u,i)=>u-ys[i]));
}

export function assessMove(v,{model=null,seed=471,selectN=24,confirmN=32,extraConfirm=0,objective='balanced',
  chosen=beliefBaseline(v),probabilities=null,continuation=heuristicContinuation,reward={}}={}) {
  if (![selectN,confirmN].every(n=>Number.isInteger(n)&&n>0)) throw Error('Both sample sizes must be positive integers.');
  if (!['play','friend'].includes(v.phase)) throw Error('Analysis supports card play and friend declaration.');
  const actions=legalActionsFromObservation(v);
  const chosenIndex=actions.findIndex(a=>actionKey(a)===actionKey(chosen));
  if (chosenIndex<0) throw Error('Chosen action is outside the legal action mask.');
  const a=compareWorlds(v,actions,objective,selectN,{model,seed,continuation,reward});
  const q=a.values.map(summary);
  const best=a.stats.accepted ? highest(q.map(row=>row.mean)) : chosenIndex;
  const worst=a.stats.accepted ? highest(q.map(row=>-row.mean)) : chosenIndex;
  if(!Number.isInteger(extraConfirm) || extraConfirm<0) throw Error('Extra sampling budget must be a nonnegative integer.');
  const confirmCount=confirmN+(a.stats.accepted && q[best].mean>q[chosenIndex].mean ? extraConfirm : 0);
  const b=compareWorlds(v,actions,objective,confirmCount,{model,seed:seed^0xb397e0a1,continuation,reward});
  const check=b.values.map(summary);
  const gap=pairedGain(b.values,best,chosenIndex), separation=pairedGain(b.values,best,worst);
  const confirmed=gap.n>=8 && gap.ci95[0]>1e-10;
  const usableTeacher=separation.n>=8 && separation.ci95[0]>1e-10;
  const delta=(a.stats.accepted && b.stats.accepted) ? Math.max(0,q[best].mean-q[chosenIndex].mean) : null;
  return {metric:'모형에 따른 추정 행동 손실',objective,scoreScale:reward.scoreScale??640,alpha:reward.alpha??.7,
    continuation:continuation.id,belief:model?'learned constrained joint proposal':'capacity-weighted constrained joint proposal',
    seed,confirmationSeed:(seed^0xb397e0a1)>>>0,requested:{selection:selectN,confirmation:confirmCount},
    selected:chosen,nominee:actions[best],estimatedLoss:delta,confirmationGap:gap,decision:confirmed?'손실 근거 있음':'판단 보류',
    teacherEligible:usableTeacher,confirmationSeparation:separation,
    actions:actions.map((action,i)=>({action,probability:probabilities?.[i]??Number(i===chosenIndex),
      selection:q[i],confirmation:check[i]})),sampler:{selection:a.stats,confirmation:b.stats},
    uncertainty:'Paired Monte Carlo t intervals under the stated sampler and continuation; they exclude model error.'};
}

// Advance the seat-local base policy even on an overridden move. The subsequent
// public trick records the actual action. Counterfactual continuations stay frozen.
export function createBeliefPolicy({model=null,objective='balanced',selectN=6,confirmN=8,basePolicy=beliefBaseline}={}) {
  return (view,rng=Math.random) => {
    const base=basePolicy(view,rng);
    if(view.phase!=='play' || view.trickNo!==9 || view.choices.plays.length<2) return base;
    const report=assessMove(view,{model,objective,selectN,confirmN,chosen:base,seed:Math.floor(rng()*2**32)});
    return report.decision==='판단 보류' ? base : report.nominee;
  };
}
