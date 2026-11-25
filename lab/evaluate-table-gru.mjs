// One paired focal-seat substitution per independent deal at the live table entry point.
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {isMainThread, parentPort, Worker, workerData} from 'node:worker_threads';
import {gzipSync} from 'node:zlib';
import {DEFAULT_RULES} from '../engine.js';
import {rngFor} from './game.js';
import {liveUtility, playLiveEpisode} from './live-game.js';
import {replayRecurrentMemory} from './recurrent.js';
import {createGatedRecurrentPolicy} from './gated-recurrent.js';
import {replayBalancedMemory} from './table-memory.js';
import {decideTableTurn, MODEL_CATALOG} from './table-agents.js';

const models = MODEL_CATALOG.map(m => m.id);
const recurrent = 'recurrent_balanced';
const reward = {alpha:.7, scoreScale:640};

function artifact(file) {
  const bytes = readFileSync(file === 'bundled' ? new URL('./table-memory.js', import.meta.url) : file);
  return {sha256:createHash('sha256').update(bytes).digest('hex'),
    model:file === 'bundled' ? null : JSON.parse(bytes)};
}

function seatPolicy(id, weights, anchor = null) {
  let lastDeal, memory;
  let opening = [];
  const evaluate = id === recurrent && weights ? createGatedRecurrentPolicy(weights, 'balanced') : null;
  const turn = evaluate ? (view, rng, previous) => {
    evaluate.restoreMemory(previous);
    const action = evaluate(view, rng);
    return {action, memory:evaluate.getMemory()};
  } : undefined;
  return (view, rng) => {
    if (view.dealNo !== lastDeal) { lastDeal = view.dealNo; memory = null; opening = []; }
    if (anchor && opening) {
      // A first-trick friend is not assigned until the first trick resolves.
      if (view.phase !== 'play' || (view.call.kind === 'first' && !view.friendKnown)) {
        const action = anchor(view, rng);
        opening.push({observation:view, action});
        return action;
      }
      memory = weights ? replayRecurrentMemory(weights, 'balanced', opening) : replayBalancedMemory(opening);
      opening = null;
    }
    const result = decideTableTurn({modelId:id, view, seed:Math.floor(rng() * 2 ** 32), memory}, turn);
    memory = result.memory ?? null;
    return result.action;
  };
}

function play(index, start, old, candidate, playOnly) {
  const seed = start + index, focal = index % 5;
  const shuffle = rngFor(seed ^ 0x235cad);
  const others = [...models, models[index % models.length]];
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(shuffle() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  others.splice(focal, 0, recurrent);
  const policies = others.map((id, seat) => seatPolicy(id, seat === focal ? candidate : old,
    playOnly && seat === focal ? seatPolicy(id, old) : null));
  const game = playLiveEpisode({seed, firstSeat:Math.floor(index / 5) % 5, policies});
  const {role, win, settlement} = game.outcomes[focal];
  return {seed, focal, role, win, settlement};
}

const metrics = ['utility', 'win', 'settlement'];
function values(row) {
  return [liveUtility(row, 'balanced', reward), row.win, row.settlement];
}

function describe(pairs) {
  const n = pairs.length;
  if (!n) return {pairs:0};
  const before = [0,0,0], after = [0,0,0];
  const differences = pairs.map(([a,b]) => {
    const x = values(a), y = values(b);
    return x.map((v,i) => { before[i] += v; after[i] += y[i]; return y[i]-v; });
  });
  // Sample each independent deal once as a block, keeping arms and metrics together.
  const random = rngFor(1749183), samples = metrics.map(() => []);
  for (let b=0; b<4000; b++) {
    const totals = [0,0,0];
    for (let j=0; j<n; j++) {
      const d = differences[Math.floor(random()*n)];
      for (let k=0; k<metrics.length; k++) totals[k] += d[k];
    }
    for (let k=0; k<metrics.length; k++) samples[k].push(totals[k]/n);
  }
  const summary = {pairs:n, lostToWon:pairs.filter(([a,b]) => b.win > a.win).length,
    wonToLost:pairs.filter(([a,b]) => b.win < a.win).length};
  metrics.forEach((name,k) => {
    const sorted = samples[k].sort((a,b)=>a-b);
    summary[name] = {before:before[k]/n, after:after[k]/n, delta:(after[k]-before[k])/n,
      ci95:[sorted[100], sorted[3899]]};
  });
  return summary;
}

async function main() {
  const [mode, oldFile, folder, deals='1600', workers='4', first='32900000', newFile] = process.argv.slice(2);
  if (mode === 'archive') {
    if (!oldFile || !folder || process.argv.length !== 5) throw Error('Use archive PAIRED_REPORT DIRECTORY');
    const raw = readFileSync(oldFile), report = JSON.parse(raw);
    if (!report.pairs || report.pairs.length !== report.spec.n) throw Error('Incomplete paired report');
    const {pairs,...metadata} = report;
    const compressed = gzipSync(raw, {level:9}), file = 'final-test.pairs.json.gz';
    const archive = {file, bytes:compressed.length, sha256:createHash('sha256').update(compressed).digest('hex')};
    mkdirSync(folder, {recursive:true});
    writeFileSync(join(folder,file),compressed);
    writeFileSync(join(folder,'final-test.json'),JSON.stringify({...metadata,archive},null,2)+'\n');
    return;
  }
  if (mode === 'pool') {
    const paths = process.argv.slice(3);
    if (!paths.length) throw Error('Use pool PAIRED_REPORT [PAIRED_REPORT ...]');
    const reports = paths.map(file => JSON.parse(readFileSync(file,'utf8')));
    const reference = report => {
      const {n,start,...config} = report.spec;
      return JSON.stringify([report.mode,report.candidateHash,config]);
    };
    if (reports.some(report => reference(report) !== reference(reports[0]))) throw Error('Mismatched comparisons');
    const pairs = reports.flatMap(report => report.pairs);
    if (new Set(pairs.map(([a]) => a.seed)).size !== pairs.length) throw Error('Overlapping deal seeds');
    console.log(JSON.stringify(describe(pairs),null,2));
    return;
  }
  const n = Number(deals), jobs = Number(workers), start = Number(first);
  if (!oldFile || !folder || !['baseline','compare','compare-play'].includes(mode) ||
      (mode !== 'baseline') !== Boolean(newFile) || !Number.isSafeInteger(n) || n<1 ||
      !Number.isSafeInteger(jobs) || jobs<1 || !Number.isSafeInteger(start) || start<0 || start+n-1>0xffffffff) {
    throw Error('Use baseline|compare|compare-play OLD_WEIGHTS DIRECTORY [DEALS WORKERS FIRST_SEED] [CANDIDATE_WEIGHTS|bundled]');
  }
  const oldPath = resolve(oldFile), candidatePath = !newFile ? oldPath : newFile === 'bundled' ? newFile : resolve(newFile);
  const oldHash = artifact(oldPath).sha256, candidateHash = artifact(candidatePath).sha256;
  const spec = {version:1, n, start, oldHash, opponents:models, rules:'table defaults', reward};
  mkdirSync(folder,{recursive:true});
  const basePath = join(folder,'baseline.json');
  const cached = mode === 'baseline' ? null : JSON.parse(readFileSync(basePath,'utf8'));
  if (cached && JSON.stringify(spec) !== JSON.stringify(cached.spec)) throw Error('Baseline cache configuration mismatch');
  const count = Math.min(jobs,n);
  const chunks = await Promise.all(Array.from({length:count},(_,k) => new Promise((accept,reject) => {
    const worker = new Worker(new URL(import.meta.url),{workerData:{k,count,n,start,oldPath,candidatePath,playOnly:mode === 'compare-play'}});
    worker.once('message',accept); worker.once('error',reject);
    worker.once('exit',code=>{ if (code) reject(Error('Worker exit '+code)); });
  })));
  const rows = chunks.flat().sort((a,b)=>a.seed-b.seed);
  if (mode === 'baseline') {
    writeFileSync(basePath,JSON.stringify({spec,rows}));
    console.log('Recorded '+rows.length+' reference seat-games at '+basePath);
    return;
  }
  if (rows.length !== cached.rows.length) throw Error('Incomplete reference cache');
  const pairs = rows.map((b,i) => {
    const a = cached.rows[i];
    if (a.seed !== b.seed || a.focal !== b.focal) throw Error('Deal or seat mismatch');
    return [a,b];
  });
  const roles = ['declarer','solo','friend','opposition'];
  const byReferenceRole = Object.fromEntries(roles.map(role =>
    [role, describe(pairs.filter(([a]) => a.role === role))]));
  const roleCounts = Object.fromEntries(roles.map(role => [role, {
    before:byReferenceRole[role].pairs, after:pairs.filter(([,b]) => b.role === role).length
  }]));
  const summary = {overall:describe(pairs), byReferenceRole, roleCounts,
    roleChanged:pairs.filter(([a,b]) => a.role !== b.role).length};
  if (mode === 'compare-play' && summary.roleChanged) throw Error('Role drifted during fixed-opening comparison');
  const destination = join(folder,(mode === 'compare-play' ? 'play-only-' : 'paired-')+candidateHash.slice(0,12)+'.json');
  writeFileSync(destination,JSON.stringify({mode,spec,tableRules:DEFAULT_RULES,candidateHash,summary,pairs}));
  console.log(JSON.stringify(summary.overall,null,2));
  console.log(destination);
}

if (isMainThread) await main();
else {
  const {k,count,n,start,oldPath,candidatePath,playOnly} = workerData;
  const old = artifact(oldPath).model, candidate = candidatePath === oldPath ? old : artifact(candidatePath).model;
  const rows = [];
  for (let i=k; i<n; i+=count) rows.push(play(i,start,old,candidate,playOnly));
  parentPort.postMessage(rows);
}
