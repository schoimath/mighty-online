// Compare declarer/friend cooperation on the same deals against the same three defenders.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isMainThread, parentPort, Worker, workerData} from 'node:worker_threads';
import {mighty} from '../engine.js';
import {playLiveEpisode} from './live-game.js';
import {rngFor} from './game.js';

const models = ['contract_search', 'recurrent_balanced', 'heuristic'];

async function playBatch({baseline, candidate, firstSeed, offset, stride, deals}) {
  const oldTurn = (await import(pathToFileURL(join(baseline, 'lab/table-agents.js')))).decideTableTurn;
  const newTurn = candidate ? (await import('./table-agents.js')).decideTableTurn : oldTurn;
  const rows = [];
  for (let i = offset; i < deals; i += stride) {
    const seed = firstSeed + i;
    const shuffle = rngFor(seed ^ 0x395716);
    const roster = [...models, models[i % 3], models[(i + 1) % 3]];
    for (let j = 4; j > 0; j--) {
      const k = Math.floor(shuffle() * (j + 1));
      [roster[j], roster[k]] = [roster[k], roster[j]];
    }
    let jokerCallsOnFriend = 0, hasTopThree = false;
    const policies = roster.map(modelId => {
      let deal, memory;
      return (view, random) => {
        if (deal !== view.dealNo) { deal = view.dealNo; memory = null; }
        const governing = view.seat === view.declarer || view.selfRole === 'friend';
        const decide = governing ? newTurn : oldTurn;
        const result = decide({modelId, view, seed:Math.floor(random() * 2 ** 32), memory});
        memory = result.memory;
        if (view.phase === 'friend' && view.bid.suit !== 'N') {
          hasTopThree = [mighty(view.bid.suit), 'JK', view.bid.suit + 'A'].every(c => view.hand.includes(c));
        }
        if (view.seat === view.declarer && view.call?.card === 'JK' && result.action.jokerCall) jokerCallsOnFriend++;
        return result.action;
      };
    });
    const game = playLiveEpisode({seed, firstSeat:i % 5, policies});
    rows.push({seed, contract:game.contract, attackPoints:game.attackPoints, won:Number(game.attackWon),
      declarerScore:game.outcomes[game.contract.seat].settlement, hasTopThree, jokerCallsOnFriend});
  }
  return rows;
}

async function main() {
  const [mode, baselinePath, file, n = '300', first = '32611000', workers = '6'] = process.argv.slice(2);
  const [deals, firstSeed, parallel] = [n, first, workers].map(Number);
  if (!['baseline','compare'].includes(mode) || !baselinePath || !file ||
      ![deals,firstSeed,parallel].every(Number.isSafeInteger) || deals < 1 || parallel < 1) {
    throw Error('Usage: baseline|compare BASE_CHECKOUT BASELINE_JSON [DEALS] [FIRST_SEED] [WORKERS]');
  }
  const stride = Math.min(parallel, deals);
  const batches = await Promise.all(Array.from({length:stride}, (_, offset) => new Promise((done, fail) => {
    const worker = new Worker(new URL(import.meta.url), {workerData:{
      baseline:resolve(baselinePath), candidate:mode === 'compare', deals, firstSeed, offset, stride
    }});
    worker.once('message', done);
    worker.once('error', fail);
    worker.once('exit', code => { if (code) fail(Error('Worker exited ' + code)); });
  })));
  const rows = batches.flat().sort((a,b) => a.seed - b.seed);
  if (mode === 'baseline') {
    writeFileSync(file, JSON.stringify(rows));
    console.log(`${rows.length} baseline deals`);
    return;
  }
  const prior = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(prior.length, rows.length);
  const summarize = pairs => {
    const sum = (column, field) => pairs.reduce((total, pair) => total + pair[column][field], 0);
    return {deals:pairs.length, wins:[sum(0,'won'),sum(1,'won')],
      lostToWon:pairs.filter(([a,b]) => b.won > a.won).length,
      wonToLost:pairs.filter(([a,b]) => b.won < a.won).length,
      totalAttackPoints:[sum(0,'attackPoints'),sum(1,'attackPoints')],
      totalDeclarerSettlement:[sum(0,'declarerScore'),sum(1,'declarerScore')],
      jokerCallsOnFriend:[sum(0,'jokerCallsOnFriend'),sum(1,'jokerCallsOnFriend')]};
  };
  const pairs = rows.map((row, i) => {
    assert.equal(prior[i].seed, row.seed);
    assert.deepEqual(prior[i].contract, row.contract);
    assert.equal(prior[i].hasTopThree, row.hasTopThree);
    return [prior[i],row];
  });
  console.log(JSON.stringify({all:summarize(pairs), topThree:summarize(pairs.filter(([a]) => a.hasTopThree))},null,2));
}

if (isMainThread) await main();
else parentPort.postMessage(await playBatch(workerData));
