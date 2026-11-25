// Duplicate-deal substitutions on the current table rules. The old benchmark remains replayable.
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync, gunzipSync} from 'node:zlib';
import {isMainThread, Worker, parentPort, workerData} from 'node:worker_threads';
import {DEFAULT_RULES} from '../engine.js';
import {TABLE_SCORING_VERSION} from '../table-scoring.js';
import {freezeRoster, parseOptions, scenarioFor} from './evaluate.mjs';
import {rngFor} from './game.js';
import {createLiveEnv, liveUtility, playLiveEpisode} from './live-game.js';
import {fitRatings, quantile, virtualMatches} from './ratings.mjs';
import {renderLiveReport} from './live-report.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const source = rel => readFileSync(new URL(rel, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const axes = ['win', 'score', 'balanced'];
const seatRole = role => role === 'opposition' ? 'defense' : 'attack';

export async function freezeLiveRoster(config, split) {
  const ids = [...new Set([...config.agents, 'heuristic', ...config.backgroundCycle[split].flatMap(k => config.backgrounds[k])])];
  if (ids.some(id => id.startsWith('gru_belief_')) && !ids.includes('recurrent_balanced')) ids.push('recurrent_balanced');
  const isRecurrent = id => id.startsWith('recurrent_') || Boolean(config.checkpoints?.[id]);
  const isBelief = id => id.startsWith('belief_') || id.startsWith('gru_belief_');
  const old = ids.filter(id => !isRecurrent(id) && !isBelief(id) && id !== 'contract_search');
  const {act, hashes} = await freezeRoster(old);
  const factories = Object.fromEntries(old.map(id => [id, () => (view, rng) => act(id, view, rng)]));
  if (ids.includes('contract_search')) {
    const {contractSearchAction} = await import('./contract-search.js');
    hashes.contract_search = hash(source('./contract-search.js') + hashes.legacy);
    factories.contract_search = () => contractSearchAction;
  }
  const recurrent = ids.filter(isRecurrent);
  if (recurrent.length) {
    const {createRecurrentPolicy, replayRecurrentMemory} = await import('./recurrent.js');
    const selected = recurrent.some(id => !config.checkpoints?.[id])
      ? (await import('./artifacts/recurrent-aux/selected.js')).recurrentModels : {};
    for (const id of recurrent) {
      const spec = config.checkpoints?.[id];
      const goal = spec?.objective ?? id.slice('recurrent_'.length);
      const model = spec ? read(resolve(spec.file)) : selected[goal];
      if (!model || !axes.includes(goal)) throw Error('Missing recurrent checkpoint or goal: ' + id);
      hashes[id] = hash(source('./recurrent.js') + JSON.stringify(model) + goal);
      factories[id] = history => {
        const policy = createRecurrentPolicy(model, goal);
        if (history) policy.restoreMemory(replayRecurrentMemory(model, goal, history));
        return policy;
      };
    }
  }
  if (ids.some(isBelief)) {
    const {createBeliefPolicy} = await import('./belief-policy.js');
    for (const id of ids.filter(isBelief)) {
      const model = id.endsWith('_uniform') ? null : read(resolve(config.belief.model));
      const opts = {...config.belief, model, objective: 'balanced'};
      const baseId = id.startsWith('gru_') ? 'recurrent_balanced' : 'heuristic';
      hashes[id] = hash(source('./belief-policy.js') + source('./belief.js') + JSON.stringify(opts) + hashes[baseId]);
      factories[id] = history => createBeliefPolicy({...opts,basePolicy:factories[baseId](history)});
    }
  }
  return {factories, hashes};
}

// The anchor really auctions, discards and calls a friend. For a first-trick call
// it also plays through trick one so the comparison starts with identical teams.
function fixedOpening(scene, focal, factories) {
  const env = createLiveEnv(scene);
  const lineup = scene.background.slice();
  lineup.splice(focal, 0, 'heuristic');
  const policies = lineup.map(id => factories[id]());
  const random = scene.policySeeds.map(rngFor);
  const history = lineup.map(() => []);
  while (!env.done) {
    const seat = env.turn, observation = env.observe(seat);
    if (observation.phase === 'play' && (observation.call.kind !== 'first' || observation.friendKnown)) break;
    if (env.dealNo > 100) throw Error('Anchor exceeded the redeal limit.');
    const action = policies[seat](observation, random[seat]);
    history[seat].push({observation, action});
    env.step(action);
  }
  return history;
}

function scenario(index, config, split, factories) {
  const scene = scenarioFor(config, split, index);
  const rows = [];
  for (let seat = 0; seat < 5; seat++) {
    const opening = config.mode === 'fixed_play' ? fixedOpening(scene, seat, factories) : null;
    for (const id of config.agents) {
      const lineup = scene.background.slice();
      lineup.splice(seat, 0, id);
      const ms = [];
      const policies = lineup.map((model, player) => {
        const history = opening?.[player];
        const decide = factories[model](history);
        let forced = 0;
        return (view, rng) => {
          if (history && forced < history.length) return history[forced++].action;
          if (seat !== player) return decide(view, rng);
          const start = performance.now();
          const action = decide(view, rng);
          ms.push(Math.round((performance.now() - start) * 1000) / 1000);
          return action;
        };
      });
      // The real game rejects illegal actions. A rejected action aborts the experiment,
      // so a successful report never silently replaces an illegal action by a legal one.
      const game = playLiveEpisode({...scene, policies});
      const me = game.outcomes[seat];
      const partners = lineup.filter((_, other) => other !== seat &&
        seatRole(game.outcomes[other].role) === seatRole(me.role)).sort();
      rows.push({seed: scene.seed, firstSeat: scene.firstSeat, background: scene.composition, lineup,
        policySeeds: scene.policySeeds, seat, agent: id, ...me, partners, contract: game.contract,
        attackPoints: game.attackPoints, misdeals: game.misdealCount, redeals: game.redealCount, ms});
    }
  }
  return rows;
}

function groupBy(items, key) {
  const grouped = new Map();
  for (const item of items) {
    const id = key(item);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(item);
  }
  return grouped;
}
function breakdown(rows, key) {
  return Object.fromEntries([...groupBy(rows, key)].map(([id, group]) => [id, {
    games: group.length, win: mean(group.map(r => r.win)), settlement: mean(group.map(r => r.settlement))
  }]));
}
function interval(point, samples) {
  return {mean: point, ci95: [quantile(samples, .025), quantile(samples, .975)]};
}

export function summarizeLive(config, deals) {
  const {agents, reward} = config;
  const random = rngFor(config.bootstrapSeed);
  const db = deals.map(rows => {
    if (rows.length !== 5 * agents.length) throw Error('Incomplete deal.');
    const conditions = new Map();
    for (const r of rows) {
      const signature = JSON.stringify([r.seed, r.firstSeat, r.policySeeds,
        r.lineup.filter((_,i) => i !== r.seat), ...(config.mode === 'fixed_play' ? [r.contract,r.role,r.partners] : [])]);
      if (conditions.has(r.seat) && conditions.get(r.seat) !== signature) throw Error('Unmatched replacement at seat ' + r.seat);
      conditions.set(r.seat, signature);
    }
    return agents.map(id => {
      const arm = rows.filter(r => r.agent === id);
      if (new Set(arm.map(r => r.seat)).size !== 5) throw Error('Incomplete five-seat replacement.');
      return axes.map(z => mean(arm.map(r => liveUtility(r, z, reward))));
    });
  });
  const groups = [...groupBy(deals.map((r, i) => ({i, bg: r[0].background})), row => row.bg).values()];
  // Every draw preserves all five focal seats, all candidate arms and the opponent mixture.
  const draws = Array.from({length: config.bootstrapDraws}, () => groups.flatMap(group =>
    group.map(() => group[Math.floor(random() * group.length)].i)));
  function estimate(values) {
    return interval(mean(values), draws.map(indices => mean(indices.map(i => values[i]))));
  }
  // Use integer seat wins for block ties (values such as .2 and .6 are inexact).
  const winCounts = db.map(deal => deal.map(arm => [Math.round(5 * arm[0])]));
  const matches = virtualMatches(winCounts, agents, config.blockSize, 0);
  const reference = agents.includes(config.reference) ? config.reference : agents[0];
  // The archived fitter exempts its pinned policy from the ridge penalty.
  // Average all choices of pin, then set the displayed reference to 1500.
  // In particular, candidates with identical game records receive equal ratings.
  const fits = agents.map(pin => fitRatings(agents, matches, pin, config.ridge));
  const elo = Object.fromEntries(agents.map(id => [id,1500 + mean(fits.map(fit => fit[id]-fit[reference]))]));
  const reports = {};
  const all = deals.flat();
  for (const [index, id] of agents.entries()) {
    const rows = all.filter(r => r.agent === id);
    const refs = [...new Set([reference, config.referenceByAgent?.[id]])].filter(r => agents.includes(r) && r !== id);
    const byMode = {};
    for (const [i, axis] of axes.entries()) {
      const values = db.map(x => x[index][i]);
      byMode[axis] = {value: estimate(values), paired: Object.fromEntries(refs.map(ref =>
        [ref, estimate(values.map((x, k) => x - db[k][agents.indexOf(ref)][i]))]))};
    }
    const scores = rows.map(r => r.settlement);
    const ms = rows.flatMap(r => r.ms);
    reports[id] = {games: rows.length, utilities: byMode, winElo: elo[id],
      settlement: {mean: mean(scores), p05: quantile(scores, .05), p50: quantile(scores, .5), p95: quantile(scores, .95)},
      role: breakdown(rows, r => r.role), crossplay: breakdown(rows, r => r.background),
      realizedPartners: breakdown(rows, r => r.background + ' | ' + (r.partners.join('+') || 'solo')),
      inference: {decisions: ms.length, p50ms: quantile(ms, .5), p95ms: quantile(ms, .95), illegal: 0}};
  }
  const ranking = Object.fromEntries(axes.map(z => [z, [...agents].sort((a,b) =>
    reports[b].utilities[z].value.mean - reports[a].utilities[z].value.mean)]));
  return {agents: reports, ranking, winEloMatches: matches};
}

async function runWorkers(config, split, hashes, jobs) {
  const count = config.splits[split].scenarios, deals = Array(count);
  const batches = Array.from({length: Math.min(jobs, count)}, () => []);
  for (let i = 0; i < count; i++) batches[i % batches.length].push(i);
  const workers = batches.map(batch => new Worker(new URL(import.meta.url), {
    workerData: {liveEvaluation: true, config, split, hashes, batch}
  }));
  try {
    await Promise.all(workers.map(worker => new Promise((ok, fail) => {
      worker.on('message', ({index, rows}) => { deals[index] = rows; });
      worker.once('error', fail);
      worker.once('exit', code => code ? fail(Error('Evaluation worker exited with ' + code)) : ok());
    })));
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
  if (deals.filter(Boolean).length !== count) throw Error('Incomplete experiment.');
  return deals;
}

export function loadLiveConfig(options = {}) {
  const config = read(resolve(options.config ?? 'configs/live-eval.json'));
  config.mode = options.mode ?? 'full';
  if (!['full','fixed_play'].includes(config.mode)) throw Error('Select full or fixed_play mode.');
  if (options.agents) config.agents = options.agents.split(',');
  if (options.checkpoints) {
    config.checkpoints = read(resolve(options.checkpoints));
    for (const [id, spec] of Object.entries(config.checkpoints)) {
      if (!config.agents.includes(id)) config.agents.push(id);
      if (spec.reference) config.referenceByAgent[id] = spec.reference;
      config.objectives[id] = spec.objective;
    }
  }
  if (!config.agents.length || new Set(config.agents).size !== config.agents.length) throw Error('Invalid candidate list.');
  return config;
}

export async function evaluateLive(options = {}) {
  const config = loadLiveConfig(options);
  const split = options.split ?? 'final_test';
  const n = config.splits[split]?.scenarios, jobs = Number(options.workers ?? config.workers);
  if (!(n > 0 && n % config.blockSize === 0 && Number.isSafeInteger(jobs) && jobs >= 1 && jobs <= 32)) {
    throw Error('Invalid split, count or worker count.');
  }
  const {hashes} = await freezeLiveRoster(config, split), start = performance.now();
  const deals = await runWorkers(config, split, hashes, jobs);
  if (JSON.stringify((await freezeLiveRoster(config, split)).hashes) !== JSON.stringify(hashes)) throw Error('Roster changed during evaluation.');
  const summary = summarizeLive(config, deals);
  const code = ['./live-game.js', './live-evaluate.mjs', '../table-deal.js', '../table-scoring.js', '../engine.js',
    './ratings.mjs', './evaluate.mjs', './game.js', './policy.js', './rules-agents.js', './partnership-policy.js',
    './search-policy.js', '../bot-sampling.js', '../bot-exchange.js', '../bot-weights.js'];
  const dir = resolve(options.out ?? 'lab/results-live', config.mode === 'fixed_play' ? 'fixed-play' : '');
  mkdirSync(dir, {recursive: true});
  const raw = deals.flat().map(row => JSON.stringify(row)).join('\n') + '\n';
  const report = {split, config, hashes, rules: DEFAULT_RULES, scoringVersion: TABLE_SCORING_VERSION,
    codeHash: hash(code.map(source).join('\n')), node: process.version, deals: n, games: deals.flat().length,
    elapsedSeconds: (performance.now() - start)/1000, rawSHA256: hash(raw), ...summary};
  writeFileSync(resolve(dir, split + '.games.jsonl.gz'), gzipSync(raw));
  writeFileSync(resolve(dir, split + '.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(resolve(dir, split + '.md'), renderLiveReport(report));
  console.log(`${split}: ${report.games} games / ${report.deals} original deals in ${report.elapsedSeconds.toFixed(1)}s`);
  console.table(Object.fromEntries(Object.entries(report.agents).map(([id, m]) =>
    [id, {win: m.utilities.win.value.mean, score: m.settlement.mean, balanced: m.utilities.balanced.value.mean}])));
  return report;
}

// Recompute a scorecard from its immutable game records, including Elo.
// This never selects a checkpoint or reruns a policy.
function rescore(file) {
  if (!file.endsWith('.json')) throw Error('Supply a live evaluation JSON report.');
  const prefix = file.slice(0, -5);
  const report = read(file);
  const raw = gunzipSync(readFileSync(prefix + '.games.jsonl.gz')).toString('utf8');
  if (hash(raw) !== report.rawSHA256) throw Error('Saved games do not match the manifest.');
  const deals = [...groupBy(raw.trim().split('\n').map(JSON.parse), row => row.seed).values()];
  if (deals.length !== report.deals) throw Error('Saved deal count differs from report.');
  Object.assign(report, summarizeLive(report.config, deals),
    {summaryCodeHash:hash(source('./live-evaluate.mjs') + source('./ratings.mjs'))});
  writeFileSync(file, JSON.stringify(report,null,2) + '\n');
  writeFileSync(prefix + '.md', renderLiveReport(report));
}

if (!isMainThread && workerData?.liveEvaluation) {
  const {config, hashes, split, batch} = workerData;
  const frozen = await freezeLiveRoster(config, split);
  if (JSON.stringify(frozen.hashes) !== JSON.stringify(hashes)) throw Error('Worker roster mismatch.');
  for (const index of batch) parentPort.postMessage({index, rows: scenario(index, config, split, frozen.factories)});
} else if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = parseOptions(process.argv.slice(2));
  if (options.report) rescore(resolve(options.report));
  else await evaluateLive(options);
}
