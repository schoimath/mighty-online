// Matched scenario-level CIs for the predeclared selection pass, independent of final_test.
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {playEpisode,rngFor} from './game.js';
import {ruleAction} from './rules-agents.js';
import {utility} from './scoring.js';

const dir=process.argv[2];
if(!dir)throw Error('Usage: node lab/selection-report.mjs lab/artifacts/run-731');
const read=f=>JSON.parse(readFileSync(f,'utf8'));
const champions=read(path.join(dir,'selection.json'));
const [exemplar]=Object.values(champions);
const config=exemplar.config;
const {selection_backgrounds:pool}=read(new URL('../configs/population.json',import.meta.url));
const validation=readFileSync(path.join(dir,'validation.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const reference=new Map();
for(let board=0;board<config.validation_scenarios;board++){
  const seed=config.validation_seed+board;
  for(let seat=0;seat<5;seat++){
    const policies=Array.from({length:5},(_,j)=>{
      const id=j===seat?'heuristic':pool[(j+board)%5];
      return (v,r)=>ruleAction(id,v,r);
    });
    const result=playEpisode({seed,firstSeat:seed%5,policies});
    reference.set([seed,seat].join('/'),result.outcomes[seat]);
  }
}
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
function interval(values){
  const rng=rngFor(8150481), draws=[];
  for(let b=0;b<3000;b++)draws.push(mean(values.map(()=>values[Math.floor(rng()*values.length)])));
  draws.sort((a,b)=>a-b);
  return [draws[75],draws[2924]];
}
const report=validation.map(({objective,generation,scenarios})=>{
  const bySeed=new Map();
  for(const r of scenarios){
    const ref=reference.get([r.seed,r.seat].join('/'));
    if(!ref)throw Error('Validation pairing mismatch');
    const diff=r.reward-utility(objective,ref,config);
    if(!bySeed.has(r.seed))bySeed.set(r.seed,[]);
    bySeed.get(r.seed).push(diff);
  }
  const differences=[...bySeed.values()].map(five=>{
    if(five.length!==5)throw Error('Only complete matched five-seat scenarios may be pooled');
    return mean(five);
  });
  const ci95=interval(differences);
  return {objective,generation,independent_scenarios:differences.length,utility:mean(scenarios.map(r=>r.reward)),
    reference:'heuristic',paired_utility_difference:mean(differences),ci95,
    inference:ci95[0]>0?'positive on validation':ci95[1]<0?'negative on validation':'inconclusive on validation',
    selected:champions[objective].generation===generation};
});
writeFileSync(path.join(dir,'validation-comparison.json'),JSON.stringify(report,null,2)+'\n');
console.log(report.filter(r=>r.selected));
