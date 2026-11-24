import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Worker,isMainThread,workerData,parentPort} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {playScenario} from './evaluate.mjs';
import {statistics,quantile} from './ratings.mjs';
import {rngFor} from './game.js';
import {ruleAction} from './rules-agents.js';
import {hybridAction} from './hybrid.js';

const config=JSON.parse(readFileSync(new URL('../configs/benchmark.json',import.meta.url)));
const agents=['legacy','controls','auction_win','auction_score'];
config.agents=agents;
config.splits.development={startSeed:1811000,scenarios:24};
config.backgroundCycle.development=['mixed','partnership','pressure','heldout_search'];
const definitions=['./hybrid.js','./hybrid-experiment.mjs','./game.js','./rules-agents.js','./scoring.js','../engine.js','../bot-sampling.js','../bot-weights.js','../bot-exchange.js'];
const version=createHash('sha256').update(definitions.map(f=>readFileSync(new URL(f,import.meta.url),'utf8').replaceAll('\r\n','\n')).join('\n')).digest('hex');
const meta={config,split:'development',hashes:{},benchmark_version:'auction-experiment-'+version.slice(0,12)};
const run=(id,v,rng)=>agents.slice(1).includes(id)?hybridAction(id,v):ruleAction(id,v,rng);

if(!isMainThread){
  for (const i of workerData) parentPort.postMessage({i,rows:playScenario(i,meta,run)});
}else{
  const counts=config.splits.development.scenarios;
  const results=Array(counts),pool=Array.from({length:4},()=>[]);
  for(let i=0;i<counts;i++)pool[i%pool.length].push(i);
  const t=performance.now();
  let done=0;
  await Promise.all(pool.map(items=>new Promise((ok,fail)=>{
    const w=new Worker(new URL(import.meta.url),{workerData:items});
    w.on('message',({i,rows})=>{results[i]=rows;if(++done%4===0)console.log(done+'/'+counts);});
    w.once('error',fail);w.on('exit',code=>code?fail(Error('Worker '+code)):ok());
  })));
  const totals=results.map(rows=>agents.map(id=>rows.filter(r=>r.agent===id).reduce((x,r)=>[x[0]+r.team_win,x[1]+r.net_settlement],[0,0])));
  const summary=statistics(totals,agents,config,rngFor(config.bootstrapSeed),results.map(rows=>rows[0].composition));
  const diagnostics=Object.fromEntries(agents.map(id=>{
    const rows=results.flat().filter(r=>r.agent===id),ms=rows.flatMap(r=>r.inference_ms);
    return [id,{contracts:rows.filter(r=>r.contract.seat===r.focal_seat).length,p95:quantile(ms,.95),max:Math.max(...ms)}];
  }));
  const report={benchmark_version:meta.benchmark_version, version,seedStart:1811000,scenarios:counts,rule:'Compare after all 24 scenarios, leave any promotion decision to a fresh holdout.',elapsedSeconds:(performance.now()-t)/1000,agents:summary.agents,diagnostics,totals};
  if(process.argv[2])writeFileSync(resolve(process.argv[2]),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,totals:undefined},null,2));
}
