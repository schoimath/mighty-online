// Paired substitutions at the actual table entry point. See TACTICS.md for the commands.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isMainThread, parentPort, Worker, workerData} from 'node:worker_threads';
import {mighty, winningPlay} from '../engine.js';
import {rngFor} from './game.js';
import {playLiveEpisode} from './live-game.js';

const models = ['contract_search', 'recurrent_balanced', 'heuristic'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

// Count explicitly described decisions; other off-suit leads need not be mistakes.
function situation(view) {
  if (view.phase !== 'play' || view.bid.suit === 'N') return;
  const trump = view.bid.suit, master = mighty(trump), moves = view.choices.plays;
  const plain = card => card !== master && card !== 'JK';
  const first = view.trick[0];
  if (first && view.selfRole === 'friend' && view.call?.card === master &&
      first.seat === view.declarer && first.card === trump + 'A' && winningPlay(view).seat === view.declarer &&
      moves.some(p => p.card === master) && moves.some(p => plain(p.card))) return 'spendMighty';
  if (first || view.seat !== view.declarer || view.trickNo < 2 || view.trickNo > 6) return;
  const held = view.hand.filter(c => c[0] === trump && plain(c));
  const seen = new Set([...view.discarded, ...(view.playedTricks ?? []).flatMap(t => t.cards.map(p => p.card))]);
  const outstandingRanks = ranks.toReversed().map(rank => trump + rank).filter(c => !seen.has(c) && plain(c));
  if (held.length >= 3 && held.includes(outstandingRanks[0]) &&
      outstandingRanks.some(c => !held.includes(c)) && moves.some(m => plain(m.card) && m.card[0] !== trump)) return 'leadTrump';
}

function eventValue(kind, card, view) {
  return Number(kind === 'spendMighty' ? card === mighty(view.bid.suit) : card[0] === view.bid.suit);
}

function play(index, firstSeed, modelId, baseline, candidate, capture) {
  const seed = firstSeed + index, focal = index % 5;
  // Cycle seat and opener independently; one conventional, one recurrent and one
  // contract-search opponent in every lineup. The fourth and seating order vary.
  const rng = rngFor(seed ^ 0x235cad);
  const others = [...models, models[index % 3]];
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [others[i],others[j]] = [others[j],others[i]];
  }
  const lineup = [...others];
  lineup.splice(focal, 0, modelId);
  const events = [];
  const policies = lineup.map((id, seat) => {
    const decide = seat === focal ? candidate : baseline;
    let dealNo, memory;
    return (view, random) => {
      if (dealNo !== view.dealNo) { dealNo = view.dealNo; memory = null; }
      const request = {modelId:id, view, seed:Math.floor(random() * 2 ** 32), memory};
      const result = decide(request);
      if (capture && seat === focal) {
        const kind = situation(view);
        if (kind) events.push({kind, request, card:result.action.card});
      }
      memory = result.memory ?? null;
      return result.action;
    };
  });
  const game = playLiveEpisode({seed, firstSeat:Math.floor(index / 5) % 5, policies});
  const me = game.outcomes[focal];
  return {seed, seat:focal, modelId, role:me.role, win:me.win, settlement:me.settlement,
    contract:game.contract, attackPoints:game.attackPoints, ...(capture ? {events} : {})};
}

async function runWorker({indices, firstSeed, baselineRoot, mode}) {
  const {decideTableTurn:base} = await import(pathToFileURL(join(baselineRoot,'lab/table-agents.js')));
  const current = mode === 'baseline' ? base : (await import('./table-agents.js')).decideTableTurn;
  return indices.flatMap(i => models.map(model => play(i, firstSeed, model, base, current, mode === 'baseline')));
}

const mean = values => values.reduce((sum,x) => sum+x,0) / values.length;
function differenceInterval(rows, field) {
  // Each independent deal occurs once per model. Resample deals, not individual
  // card plays, preserving the old/new pairing and shared deal across all models.
  const byDeal = new Map();
  for (const row of rows) {
    const values = byDeal.get(row.seed) ?? [];
    values.push(row[field]); byDeal.set(row.seed,values);
  }
  const diffs = [...byDeal.values()].map(mean), rng = rngFor(3560931);
  const draws = Array.from({length:1600}, () => {
    let total=0;
    for (let i=0; i<diffs.length; i++) total += diffs[Math.floor(rng()*diffs.length)];
    return total/diffs.length;
  }).sort((a,b)=>a-b);
  return [mean(diffs),draws[Math.floor(.025*draws.length)],draws[Math.floor(.975*draws.length)]];
}

async function summarize(oldRows, newRows) {
  if (oldRows.length !== newRows.length) throw Error('Mismatched sample size.');
  const {decideTableTurn} = await import('./table-agents.js');
  const paired = oldRows.map((a,i) => {
    const b = newRows[i];
    if (a.seed!==b.seed || a.seat!==b.seat || a.modelId!==b.modelId || a.role!==b.role ||
        JSON.stringify(a.contract)!==JSON.stringify(b.contract)) throw Error('Opening or pair mismatch: '+JSON.stringify(b));
    const events = a.events.map(({kind, request, card}) => ({kind,
      before:eventValue(kind,card,request.view),
      after:eventValue(kind,decideTableTurn(request).action.card,request.view)}));
    return {seed:a.seed, modelId:a.modelId, seat:a.seat, role:a.role,
      win:b.win-a.win, settlement:b.settlement-a.settlement, beforeWin:a.win, afterWin:b.win,
      beforeSettlement:a.settlement, afterSettlement:b.settlement, attackBefore:a.attackPoints, attackAfter:b.attackPoints, events};
  });
  const summary = {};
  for (const model of [...models,'all']) {
    const rows = paired.filter(r=>model==='all' || r.modelId===model);
    const events=rows.flatMap(r=>r.events);
    const count = k => {
      const e=events.filter(r=>r.kind===k);
      return {opportunities:e.length,before:e.reduce((s,r)=>s+r.before,0),after:e.reduce((s,r)=>s+r.after,0)};
    };
    summary[model] = {pairs:rows.length, winBefore:mean(rows.map(r=>r.beforeWin)), winAfter:mean(rows.map(r=>r.afterWin)),
      meanWinDeltaCI:differenceInterval(rows,'win'), lostToWon:rows.filter(r=>r.win>0).length, wonToLost:rows.filter(r=>r.win<0).length,
      pointsBefore:mean(rows.map(r=>r.beforeSettlement)), pointsAfter:mean(rows.map(r=>r.afterSettlement)),
      meanPointsDeltaCI:differenceInterval(rows,'settlement'), spendMighty:count('spendMighty'), leadTrump:count('leadTrump')};
  }
  return {summary, paired};
}

async function main() {
  const [mode, root, output, n='150', workers='6', seed='16020000'] = process.argv.slice(2);
  if (!root || !output || !['baseline','compare'].includes(mode) || !Number.isSafeInteger(+n) || +n<1 ||
      !Number.isSafeInteger(+workers) || +workers<1 || !Number.isSafeInteger(+seed))
    throw Error('Arguments: baseline|compare BASE_CHECKOUT OUTPUT_DIR [DEALS] [WORKERS] [FIRST_SEED]');
  const baselineRoot=resolve(root), out=resolve(output), count=Math.min(+n,+workers);
  mkdirSync(out,{recursive:true});
  const chunks = await Promise.all(Array.from({length:count}, (_,k)=>new Promise((resolve,reject)=>{
    const indices=Array.from({length:Math.ceil((+n-k)/count)},(_,i)=>k+i*count);
    const worker=new Worker(new URL(import.meta.url),{workerData:{indices,firstSeed:+seed,baselineRoot,mode}});
    worker.once('message',resolve); worker.once('error',reject);
    worker.once('exit',code=>{if(code!==0)reject(Error('Worker exited '+code));});
  })));
  const rows=chunks.flat().sort((a,b)=>a.seed-b.seed || models.indexOf(a.modelId)-models.indexOf(b.modelId));
  if (mode==='baseline') {
    writeFileSync(join(out,'baseline.json'),JSON.stringify(rows));
    console.log(rows.length+' baseline seat-games');
  } else {
    const report=await summarize(JSON.parse(readFileSync(join(out,'baseline.json'),'utf8')),rows);
    writeFileSync(join(out,'paired.json'),JSON.stringify(report));
    console.log(JSON.stringify(report.summary,null,2));
  }
}

if (isMainThread) await main();
else parentPort.postMessage(await runWorker(workerData));
