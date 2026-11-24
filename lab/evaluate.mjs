import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {basename, dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {playEpisode, rngFor} from './game.js';
import {ruleAction} from './rules-agents.js';
import {rulesHash, scoringHash, observationVersion, actionVersion, rngVersion} from './version.mjs';

const ruleIds = new Set(['legacy','heuristic','conservative','aggressive','random']);
const digest = text => createHash('sha256').update(text).digest('hex');
const source = rel => readFileSync(new URL(rel, import.meta.url), 'utf8').replaceAll('\r\n','\n');
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/,''));
const ruleFiles = ['./rules-agents.js','../engine.js','../bot-sampling.js','../bot-weights.js','../bot-exchange.js'];

export async function freezeRoster(ids) {
  const needsNeural = ids.some(id => !ruleIds.has(id));
  const weightFile = new URL('./champions.js',import.meta.url);
  if (needsNeural) weightFile.searchParams.set('version',digest(source('./champions.js')));
  const champions = needsNeural ? (await import(weightFile.href)).champions : {};
  const neural = needsNeural ? (await import('./policy.js')).neuralAction : null;
  const act = (id,view,rng) => ruleIds.has(id) ? ruleAction(id,view,rng) : neural(champions[id],view,rng);
  const base = ruleFiles.map(source).join('\n');
  const hashes = Object.fromEntries(ids.map(id => {
    if (!ruleIds.has(id) && !champions[id]) throw new Error('Missing selected checkpoint for '+id);
    return [id, digest(ruleIds.has(id) ? id+'\n'+base : JSON.stringify(champions[id]))];
  }));
  return {hashes,act};
}

export function scenarioFor(config, split, index) {
  const spec = config.splits[split];
  const seed = spec.startSeed + index;
  const sequence = config.backgroundCycle[split];
  const composition = sequence[index % sequence.length];
  // Keep the four background strategies in their same physical seats for any given substitution.
  const shift = Math.floor(index / sequence.length) % 4;
  const background = config.backgrounds[composition].map((_,i) => config.backgrounds[composition][(i+shift)%4]);
  const random = rngFor(seed ^ 0x74e1abcd);
  return {seed, scenario_id:split+'-'+seed, firstSeat:index%5, composition, background,
    policySeeds:Array.from({length:5},() => Math.floor(random()*4294967296))};
}

export function playScenario(index, meta, act) {
  const {config,split,hashes,benchmark_version} = meta;
  const scene = scenarioFor(config,split,index);
  const rows = [];
  for (let focal = 0; focal < 5; focal++) {
    const others = scene.background;
    for (const id of config.agents) {
      const lineup = others.slice(); lineup.splice(focal,0,id);
      const times = [];
      const policies = lineup.map((model,seat) => (view,rng) => {
        const start = performance.now();
        const action = act(model,view,rng);
        const ms = performance.now() - start;
        if (ms > config.decisionTimeLimitMs) throw new Error('Timed out: '+model+' at '+scene.scenario_id);
        if (seat === focal) times.push(Math.round(ms*1000)/1000);
        return action;
      });
      const start = performance.now();
      const game = playEpisode({seed:scene.seed,firstSeat:scene.firstSeat,policies,policySeeds:scene.policySeeds,maxRedeals:config.maxRedeals});
      const me = game.outcomes[focal];
      rows.push({benchmark_version, split, scenario_id:scene.scenario_id, seed:scene.seed, first_seat:scene.firstSeat,
        focal_seat:focal,agent:id,agent_checkpoint_hash:hashes[id],composition:scene.composition,
        background_agents:others, background_agent_hashes:others.map(b => hashes[b]), policy_rng_seeds:scene.policySeeds,
        inference_mode: id==='random' ? 'legal-random' : 'greedy', redeal_count:game.redealCount,
        terminal_role:me.role,team_win:me.win,net_settlement:me.settlement,captured_points:me.captured,
        contract:game.contract,contract_success:game.attackWon,actions:game.actions,
        elapsed_time:Math.round((performance.now()-start)*1000)/1000, inference_ms:times,illegal_action_count:0,timeout_count:0});
    }
  }
  return rows;
}

async function runWorker() {
  const {meta,indices} = workerData;
  const {hashes,act} = await freezeRoster(Object.keys(meta.hashes));
  if (JSON.stringify(hashes)!==JSON.stringify(meta.hashes)) throw new Error('Checkpoint changed after freeze');
  for (const index of indices) parentPort.postMessage({index, rows:playScenario(index,meta,act)});
}

async function gather(meta, workers) {
  const count = meta.config.splits[meta.split].scenarios;
  const batches = Array.from({length:Math.min(workers,count)},()=>[]);
  for (let i=0;i<count;i++) batches[i%batches.length].push(i);
  const rows = Array(count);
  const pool = batches.map(indices => new Worker(new URL(import.meta.url), {workerData:{meta,indices}}));
  try {
    let done = 0;
    await Promise.all(pool.map(worker=> new Promise((ok,fail)=>{
      worker.on('message', chunk => {
        rows[chunk.index] = chunk.rows;
        if (++done % 8 === 0 || done===count) console.log(meta.split,done+'/'+count+' scenarios');
      });
      worker.once('error',fail);
      worker.once('exit',code=>code===0 ? ok() : fail(new Error('Worker exited '+code)));
    })));
    if (rows.filter(Boolean).length!==count) throw new Error('Incomplete evaluation');
  } finally { await Promise.all(pool.map(w=>w.terminate())); }
  return rows.flat();
}

export function parseOptions(argv) {
  const options = {};
  for (let i=0; i<argv.length; i+=2) {
    if (!argv[i].startsWith('--') || argv[i+1] == null || argv[i+1].startsWith('--')) throw new Error('Missing option value: '+argv[i]);
    options[argv[i].slice(2)] = argv[i+1];
  }
  return options;
}

export async function evaluate(options) {
  const split = options.split ?? 'validation';
  const config = readJson(resolve(options.manifest ?? 'configs/benchmark.json'));
  if (split === 'smoke') {
    config.splits.smoke={startSeed:832000,scenarios:4};
    config.agents=config.agents.filter(id=>ruleIds.has(id));
    config.backgroundCycle.smoke=['mixed','partnership'];
  }
  const spec = config.splits[split];
  if (!spec || !config.backgroundCycle[split] || !Number.isInteger(spec.scenarios) || spec.scenarios<=0 || spec.scenarios%config.blockSize) throw new Error('Invalid split or block size');
  if (split==='validation' && (spec.startSeed<1000000 || spec.startSeed+spec.scenarios>2000000) ||
      split==='final_test' && (spec.startSeed<2000000 || spec.startSeed+spec.scenarios>3000000)) throw new Error('Seed outside its split');
  const jobs = Number(options.workers ?? 3);
  if (!Number.isInteger(jobs) || jobs<1 || jobs>64) throw new Error('Invalid CPU worker count');
  const ids = [...new Set([...config.agents,...Object.values(config.backgrounds).flat()])];
  const {hashes} = await freezeRoster(ids);
  const selected = config.agents.filter(id=>!ruleIds.has(id));
  const selection = {};
  if (selected.length) {
    const records = readJson(new URL('./artifacts/champions.json',import.meta.url));
    for (const id of selected) {
      const record = records[id];
      if (record?.weight_hash !== hashes[id]) throw new Error('Published weights and selection record do not match: '+id);
      selection[id] = {hash:record.weight_hash, file:record.file, checkpoint:record.checkpoint, run_path:record.run_path, generation:record.generation,
        training_seed:record.training_seed, validation_utility:record.validation_utility, selection_scenarios:record.config.validation_scenarios,
        alpha:record.config.alpha,lambdaRisk:record.config.lambdaRisk};
    }
  }
  const codeHash = digest(['./game.js','./evaluate.mjs','./rate.mjs','./ratings.mjs','./scoring.js','./rules-agents.js',...(config.agents.some(id=>!ruleIds.has(id)) ? ['./policy.js','./agents.js']:[])].map(source).join('\n'));
  const benchmark_version = config.name+'-'+digest(JSON.stringify({config,hashes,codeHash,rulesHash,scoringHash,observationVersion,actionVersion,rngVersion,selection,jobs})).slice(0,16);
  const meta = {benchmark_version,split,hashes,selection,rulesHash,scoringHash,codeHash,observationVersion,actionVersion,rngVersion,
    node:process.version, platform:process.platform+'/'+process.arch, workers:jobs, config};
  const prefix = resolve(options.out ?? 'lab/results',split);
  mkdirSync(dirname(prefix),{recursive:true});
  if (existsSync(prefix+'.manifest.json') && readJson(prefix+'.manifest.json').benchmark_version!==benchmark_version) {
    throw new Error('Results for another benchmark version exist; select a separate --out directory.');
  }
  const start = performance.now();
  let rows;
  try {
    rows = await gather(meta,jobs);
    const verified = await freezeRoster(ids);
    if (JSON.stringify(hashes)!==JSON.stringify(verified.hashes)) throw new Error('Checkpoint hashes changed during evaluation');
  } catch(error) {
    writeFileSync(prefix+'.incomplete.json',JSON.stringify({...meta,error:error.message},null,2));
    throw error;
  }
  meta.wall_seconds = (performance.now()-start)/1000;
  const raw = rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
  meta.results_sha256 = digest(raw);
  writeFileSync(prefix+'.jsonl.tmp',raw);
  writeFileSync(prefix+'.manifest.json.tmp',JSON.stringify(meta,null,2)+'\n');
  renameSync(prefix+'.jsonl.tmp',prefix+'.jsonl');
  renameSync(prefix+'.manifest.json.tmp',prefix+'.manifest.json');
  console.log(basename(prefix)+': '+rows.length+' games, '+meta.wall_seconds.toFixed(1)+' s, '+benchmark_version);
  const {rate} = await import('./rate.mjs');
  return rate(prefix+'.jsonl');
}

if (!isMainThread && workerData?.meta) {
  await runWorker();
} else if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  if (process.argv.includes('--help')) console.log('node lab/evaluate.mjs --manifest configs/benchmark.json --split smoke|validation|final_test [--workers 3] [--out lab/results]');
  else await evaluate(parseOptions(process.argv.slice(2)));
}
