import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assessMove} from './belief-policy.js';
import {position,saveJSON} from './belief-experiment.mjs';

export function teacherExperiment({model,out,positions=80,selectN=12,confirmN=20,extraConfirm=12,temperature=.12,seed=249000}) {
  const records=[], summary={positions,seed,selectN,confirmN,extraConfirm,temperature,objectives:{}};
  for(const objective of ['win','score','balanced']) summary.objectives[objective]={analyzed:0,kept:0,confirmedMistakes:0,lossSum:0};
  for(let i=0;i<positions;i++) {
    const p=position(seed+i,5+i%5,{branch:true,withHistory:true,
      policies:['heuristic','conservative','aggressive','heuristic','conservative']});
    if(!p) continue;
    for(const objective of Object.keys(summary.objectives)) {
      const report=assessMove(p.observation,{model,seed:seed+i,selectN,confirmN,extraConfirm,objective});
      const metrics=summary.objectives[objective];
      metrics.analyzed++;
      metrics.lossSum+=report.estimatedLoss??0;
      if(report.decision!=='판단 보류') metrics.confirmedMistakes++;
      if(!report.teacherEligible) continue;
      const q=report.actions.map(row=>row.confirmation.mean),peak=Math.max(...q);
      const tau=objective==='score' ? temperature/10 : temperature;
      const weights=q.map(value=>Math.exp((value-peak)/tau));
      const z=weights.reduce((a,b)=>a+b,0);
      const {mean,ci95}=report.confirmationSeparation;
      records.push({objective,seed:seed+i,history:p.histories[p.observation.seat],observation:p.observation,
        actions:report.actions.map(row=>row.action),teacherQ:q,temperature:tau,probabilities:weights.map(w=>w/z),
        weight:Math.min(1,ci95[0]/mean)});
      metrics.kept++;
    }
  }
  for(const m of Object.values(summary.objectives)) {
    m.meanEstimatedLoss=m.lossSum/m.analyzed;
    m.abstentionFraction=1-m.confirmedMistakes/m.analyzed;
    delete m.lossSum;
  }
  saveJSON(out+'/teacher-summary.json',summary);
  writeFileSync(out+'/teachers.jsonl',records.map(x=>JSON.stringify(x)).join('\n')+(records.length?'\n':''));
  return summary;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg=(key,def)=>process.argv.includes('--'+key)?process.argv[process.argv.indexOf('--'+key)+1]:def;
  const out=arg('out','lab/artifacts/belief'),model=JSON.parse(readFileSync(arg('belief',out+'/ownership.json'),'utf8'));
  const options={out,model,positions:Number(arg('positions',80)),selectN:Number(arg('selection',12)),
    confirmN:Number(arg('confirmation',20)),temperature:Number(arg('temperature',.12)),seed:Number(arg('seed',249000))};
  console.log(JSON.stringify(teacherExperiment(options),null,2));
}
