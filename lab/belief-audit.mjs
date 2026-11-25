// Sealed diagnostics. These deals never feed model selection or teacher fitting.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {position,saveJSON} from './belief-experiment.mjs';
import {analyzeObservation} from './analyze-move.mjs';

export async function audit({positions=24,seed=3050071,checkpointDir='lab/artifacts/recurrent',selectN=12,confirmN=20,
  out='lab/artifacts/belief/action-audit.json'}={}) {
  const model=JSON.parse(readFileSync('lab/artifacts/belief/ownership.json','utf8'));
  const summaries={};
  for (const objective of ['win','score','balanced']) {
    const rows=[];
    for(let i=0;i<positions;i++) {
      const p=position(seed+i,5+i%5,{branch:true,policies:['heuristic','conservative','aggressive','heuristic','conservative']});
      if(!p) continue;
      const report=await analyzeObservation(p.observation,{model,seed:seed+i,objective,selectN,confirmN,
        checkpoint:checkpointDir+'/best-'+objective+'.json'});
      rows.push({seed:seed+i,trick:p.observation.trickNo,role:p.observation.selfRole,actor:report.actor,
        chosen:report.selected,nominee:report.nominee,loss:report.estimatedLoss,confirmed:report.decision!=='판단 보류',
        gap:report.confirmationGap,sampler:report.sampler,continuation:report.continuation});
    }
    const scored=rows.filter(r=>r.loss!==null);
    summaries[objective]={positions:rows.length,scored:scored.length,
      meanEstimatedActionLoss:scored.reduce((a,r)=>a+r.loss,0)/scored.length,
      abstentionFraction:rows.filter(r=>!r.confirmed).length/rows.length,rows};
  }
  const report={split:'held-out action diagnostics only',seed,selectN,confirmN,checkpointDir,
    warning:'Monte Carlo action loss under the learned joint proposal and the same frozen heuristic continuation.',
    objectives:summaries};
  saveJSON(out,report);
  return report;
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const arg=(key,def)=>process.argv.includes('--'+key)?process.argv[process.argv.indexOf('--'+key)+1]:def;
  const report=await audit({positions:Number(arg('positions',24)),seed:Number(arg('seed',3050071)),
    checkpointDir:arg('checkpoints','lab/artifacts/recurrent'),out:arg('out','lab/artifacts/belief/action-audit.json')});
  for(const [key,{rows,...summary}] of Object.entries(report.objectives)) console.log(key,summary);
}
