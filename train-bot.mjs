// Offline cross-entropy policy search. Only the terminal reward uses the
// settled partnerships. Each decision gets the same projection as a guest.
import {writeFileSync} from 'node:fs';
import {applyAction, baselineDiscard, baselinePlay, botDecision, botObservation, createGame, getView, policyPlay, searchPlay} from './engine.js';
import {playWeights} from './bot-weights.js';

const warmStart = [4, 2, 2, 2, 1, 1, 1, 1, 1, 1];
const scales = [0, 3, 2, 2, 3, 3, 2, 2, 1.5, 2];
const seed = {train: 44121, validation: 251137, development: 795631, test: 1741389, search: 11937};
const config = {generations: 10, candidates: 16, trainDeals: 16, validationDeals: 48, testDeals: 400};
const suits = ['S', 'H', 'D', 'C'];
const deck = [...suits.flatMap(s => ['A','K','Q','J','10','9','8','7','6','5','4','3','2'].map(r => s+r)), 'JK'];
const order = new Map(deck.map((card, i) => [card, i]));
const emptyRound = createGame();

function generator(initial) {
  let x = initial;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function startDeal(random, first, dealNo) {
  const cards = deck.slice();
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  const state = structuredClone(emptyRound);
  state.firstSeat = state.turn = first;
  state.dealNo = dealNo;
  state.hands = Array.from({length: 5}, (_, i) => cards.slice(i * 10, i * 10 + 10).sort((a,b) => order.get(a)-order.get(b)));
  state.kitty = cards.slice(50);
  return state;
}

function finish(start, actor, policy) {
  const game = structuredClone(start);
  while (game.phase === 'play') {
    const seat = game.turn, view = seat === actor ? botObservation(game,seat) : getView(game,seat);
    const move = seat === actor ? policy(view) : baselinePlay(view);
    applyAction(game, seat, {type: 'play', ...move});
  }
  return game.result;
}

function scored(result, actor) {
  const attacking = actor === result.declarer || actor === result.friend;
  const won = Number(result.won === attacking);
  return {points: attacking ? result.points : 20 - result.points, won};
}

function startAt(random, first, phase) {
  let state = startDeal(random, first, 1);
  while (state.phase !== phase) {
    const previousDeal = state.dealNo;
    applyAction(state, state.turn, botDecision(getView(state,state.turn), baselinePlay, baselineDiscard));
    if (state.dealNo !== previousDeal) state = startDeal(random, state.turn, state.dealNo);
  }
  return state;
}

function deals(random, count, combined = false) {
  return Array.from({length:count}, (_, index) => {
    const exchange = startAt(random, index % 5, 'discard');
    function prepare(discardPolicy) {
      const round = structuredClone(exchange);
      while (round.phase !== 'play') {
        applyAction(round,round.turn,botDecision(getView(round,round.turn),baselinePlay,discardPolicy));
      }
      return round;
    }
    const state = prepare(baselineDiscard);
    const reference = finish(state, -1, baselinePlay);
    return {state, reference, upgradedExchange: combined ? prepare(undefined) : null};
  });
}

function outcomes(boards, policy) {
  return boards.map(({state}) => Array.from({length:5},(_,seat) => finish(state,seat,policy)));
}

function compare(boards, results, references) {
  let points = 0, won = 0, baselineWon = 0, gains = 0, losses = 0;
  const dealWins = [], dealPoints = [];
  for (const [index, {reference}] of boards.entries()) {
    let boardWins = 0, boardPoints = 0;
    for (let seat = 0; seat < 5; seat++) {
      const original = scored(references?.[index][seat] || reference,seat);
      const played = scored(results[index][seat],seat);
      const difference = played.won - original.won;
      boardPoints += played.points - original.points;
      won += played.won;
      baselineWon += original.won;
      gains += Number(difference > 0);
      losses += Number(difference < 0);
      boardWins += difference;
    }
    dealWins.push(boardWins / 5);
    dealPoints.push(boardPoints / 5);
    points += boardPoints;
  }
  const n = boards.length * 5;
  const difference = (won - baselineWon) / n;
  // Five seat substitutions share the same deal, so uncertainty is measured
  // across independent deals rather than across the five outcomes separately.
  function interval(deltas, average) {
    const variance = deltas.reduce((sum,delta) => sum + (delta-average) ** 2, 0) / (boards.length-1);
    const margin = 1.96 * Math.sqrt(variance/boards.length);
    return [average-margin, average+margin];
  }
  return {n, won, baselineWon, gains, losses, pointDelta: points/n, rewardDelta: points/n + 3*difference,
    winDelta: difference, winInterval: interval(dealWins,difference), pointInterval: interval(dealPoints,points/n)};
}

function evaluate(boards, weights) {
  return compare(boards,outcomes(boards,view => policyPlay(view,weights)));
}

function report() {
  const boards = deals(generator(seed.test),config.testDeals,true);
  const warm = outcomes(boards,view => policyPlay(view,warmStart));
  const trained = outcomes(boards,policyPlay);
  const searched = outcomes(boards,searchPlay);
  const deployed = searched.map((row,i) => {
    const upgraded = boards[i].upgradedExchange;
    const result = row.slice();
    result[upgraded.declarer] = finish(upgraded,upgraded.declarer,searchPlay);
    return result;
  });
  console.log(JSON.stringify({seed:seed.test,deals:boards.length,warm:compare(boards,warm),
    trained:compare(boards,trained),trainedVsWarm:compare(boards,trained,warm),
    fixedExchange:compare(boards,searched),deployed:compare(boards,deployed)},null,2));
}

function train() {
  const training = generator(seed.train), random = generator(seed.search);
  const normal = () => Math.sqrt(-2 * Math.log(1-random())) * Math.cos(2 * Math.PI * random());
  const validation = deals(generator(seed.validation),config.validationDeals);
  let mean = warmStart.slice(), best = warmStart.slice();
  let bestReward = evaluate(validation,best).rewardDelta;
  console.log('Initial validation reward gain',bestReward.toFixed(3));
  for (let gen = 0; gen < config.generations; gen++) {
    const boards = deals(training,config.trainDeals);
    const population = [mean, best];
    const step = 1.3 - 0.07*gen;
    while (population.length < config.candidates) {
      const offset = scales.map(scale => normal()*scale*step);
      for (const sign of [-1,1]) population.push(mean.map((value,i) => value + sign*offset[i]));
    }
    const ranked = population.map(weights => ({weights, value: evaluate(boards, weights).rewardDelta}))
      .sort((a,b) => b.value - a.value);
    const elite = ranked.slice(0,4);
    mean = mean.map((value,i) => value * 0.25 + 0.75 * elite.reduce((sum,p) => sum+p.weights[i],0)/elite.length);
    for (const weights of [mean, ranked[0].weights]) {
      const value = evaluate(validation,weights).rewardDelta;
      if (value > bestReward) { best = weights.slice(); bestReward = value; }
    }
    console.log('Generation',gen+1,'best validation reward gain',bestReward.toFixed(3));
  }
  const output = best.map(x => Number(x.toFixed(6)));
  writeFileSync(new URL('./bot-weights.js',import.meta.url),
    '// Offline policy-search output. Regenerate with node train-bot.mjs train.\n' +
    'export const playWeights = ' + JSON.stringify(output) + ';\n');
  console.log('Saved weights',output);
}

function evaluateExchange() {
  const seed = 213027, count = 1000, random = generator(seed);
  let baselineWins = 0, newWins = 0, gains = 0, losses = 0, points = 0;
  function settle(round, discardPolicy) {
    // Only the three buried cards can differ. Both teams play the original policies.
    while (round.phase !== 'play') {
      applyAction(round, round.turn, botDecision(getView(round,round.turn), baselinePlay, discardPolicy));
    }
    return finish(round, -1, baselinePlay);
  }
  for (let i = 0; i < count; i++) {
    const round = startAt(random, i % 5, 'discard');
    const base = settle(structuredClone(round), baselineDiscard);
    const improved = settle(round);
    baselineWins += Number(base.won);
    newWins += Number(improved.won);
    gains += Number(improved.won && !base.won);
    losses += Number(!improved.won && base.won);
    points += improved.points - base.points;
  }
  return {seed, deals:count, baselineWins, newWins, gains, losses, declarerPointDelta:points/count};
}

if (process.argv[2] === 'train') train();
else if (process.argv[2] === 'evaluate-exchange') console.log(JSON.stringify(evaluateExchange(), null, 2));
else if (process.argv[2] === 'evaluate') report();
else if (process.argv[2] === 'development') {
  const boards = deals(generator(seed.development),120);
  console.log(JSON.stringify({seed: seed.development,deals: boards.length,
    released: compare(boards,outcomes(boards,searchPlay))},null,2));
} else {
  console.error('Usage: node train-bot.mjs train|evaluate|evaluate-exchange|development');
  process.exitCode = 1;
}
