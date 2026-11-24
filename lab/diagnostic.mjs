import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {applyAction, botObservation, createGame} from '../engine.js';
import {rngFor} from './game.js';
import {ruleAction} from './rules-agents.js';
import {outcomes, utility} from './scoring.js';

export function expectedLoss(rows, weights, selected) {
  if (!weights.length || weights.some(p => !Number.isFinite(p) || p < 0) ||
      Math.abs(weights.reduce((a,b) => a+b,0)-1) > 1e-9) throw new Error('Invalid prior.');
  if (!Number.isInteger(selected) || !rows[selected]) throw new Error('Action outside the candidate set.');
  const values = rows.map(row => {
    if (row.length !== weights.length || row.some(v => !Number.isFinite(v))) throw new Error('Each world needs a utility.');
    return row.reduce((sum,v,i) => sum + weights[i]*v, 0);
  });
  return {values, loss: Math.max(...values) - values[selected]};
}

function play(state, action) { applyAction(state, state.turn, action); }
const continuation = view => ruleAction('heuristic', view);

// Reconstruct two deals compatible with the *entire* observed game, including voids.
// A specified two-world prior is a small exact problem, not the distribution of live deals.
export function endgameWorlds({seed, trick, offset = 0, swapIndex = 0}) {
  const initial = createGame({random:rngFor(seed)});
  const state = structuredClone(initial), history = [];
  function step(action) { history.push({seat:state.turn, action}); play(state, action); }
  step({type:'bid', suit:'H', points:14});
  for (let i=0; i<4; i++) step({type:'pass'});
  while (state.phase !== 'play' || state.trickNo < trick || state.trick.length < offset ||
    botObservation(state,state.turn).choices.plays.length < 2) {
    if (state.phase === 'result') throw new Error('No branching endgame for seed ' + seed);
    step(continuation(botObservation(state,state.turn)));
  }
  const seat = state.turn, observation = botObservation(state, seat);
  let index = 0;
  for (let a=1; a<5; a++) for (let b=a+1; b<5; b++) {
    if (seat === a || seat === b) continue;
    for (const x of state.hands[a]) for (const y of state.hands[b]) {
      const other = structuredClone(initial);
      other.hands[a][other.hands[a].indexOf(x)] = y;
      other.hands[b][other.hands[b].indexOf(y)] = x;
      for (const s of [a,b]) {
        const order = c => c === 'JK' ? 99 : 'SHDC'.indexOf(c[0])*13 +
          ['A','K','Q','J','10','9','8','7','6','5','4','3','2'].indexOf(c.slice(1));
        other.hands[s].sort((u,v) => order(u)-order(v));
      }
      try { for (const move of history) applyAction(other, move.seat, move.action); }
      catch { continue; } // Contract, follow-suit, Joker call or another public play excludes this world.
      if (JSON.stringify(botObservation(other,seat)) !== JSON.stringify(observation)) continue;
      if (index++ === swapIndex) return {seat, observation, states:[state,other], swap:[x,y]};
    }
  }
  throw new Error('No compatible alternative for seed ' + seed);
}

export function analyzeEndgame(problem, actor, objective, params) {
  const {observation, states, seat, swap} = endgameWorlds(problem);
  const candidates = observation.choices.plays.map(p => ({type:'play',...p}));
  const choice = actor(structuredClone(observation),rngFor(problem.seed));
  const selected = candidates.findIndex(p => p.card === choice.card && p.suit === choice.suit &&
    Boolean(p.jokerCall) === Boolean(choice.jokerCall));
  const rows = candidates.map(action => states.map(original => {
    const state = structuredClone(original);
    play(state, action);
    while (!state.result) play(state, continuation(botObservation(state,state.turn)));
    return utility(objective,outcomes(state)[seat],params);
  }));
  return {seed:problem.seed, seat, trick:observation.trickNo, hand:observation.hand, swap,
    weights:problem.weights, candidates, worldUtilities:rows, choice, objective,
    ...expectedLoss(rows,problem.weights,selected)};
}

export async function diagnose({suite='configs/endgames.json', agent='win', objective='win'}={}) {
  const conf = JSON.parse(readFileSync(suite,'utf8'));
  const {chooseModelAction,isModelId} = await import('./agents.js');
  let actor = (obs,rng) => chooseModelAction(agent,obs,rng);
  if (!isModelId(agent)) {
    const checkpoint = JSON.parse(readFileSync(agent,'utf8'));
    const {neuralAction} = await import('./policy.js');
    actor = (obs,rng) => neuralAction(checkpoint.weights ?? checkpoint, obs,rng);
  }
  return {method:'A: exact finite information set; all legal plays; frozen heuristic continuation',
    prior:'Specified two-deal prior conditional on public legality; no inference from bidding style.',
    utility:objective, actor:agent, hindsightExample:expectedLoss([[1,0],[0,1]],[.7,.3],0),
    positions:conf.positions.map(p => analyzeEndgame(p,actor,objective))};
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = name => process.argv[process.argv.indexOf(name)+1];
  const opt = {};
  for (const key of ['suite','agent','objective']) if (process.argv.includes('--'+key)) opt[key]=arg('--'+key);
  console.log(JSON.stringify(await diagnose(opt),null,2));
}
