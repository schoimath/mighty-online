import assert from 'node:assert/strict';
import test from 'node:test';
import {pointsIn} from '../engine.js';
import {applyAction, createGame} from '../table-deal.js';
import {settlements} from '../table-scoring.js';
import {rngFor} from '../lab/game.js';
import {createLiveEnv, liveUtility, playLiveEpisode} from '../lab/live-game.js';
import {ruleAction} from '../lab/rules-agents.js';
import {summarizeLive} from '../lab/live-evaluate.mjs';

test('a seeded training episode replays exactly on the room engine, including zero-point and all-pass redeals', () => {
  const ids = ['random','conservative','heuristic','aggressive','random'];
  const policies = ids.map(id => (view,rng) => view.phase === 'bid' && view.dealNo === 1
    ? {type:'pass'} : ruleAction(id, view, rng));
  const options = {seed: 698, firstSeat: 3, policies, record: true};
  const game = playLiveEpisode(options);
  assert.deepEqual(game, playLiveEpisode(options));
  assert.ok(game.misdealCount >= 2);
  assert.ok(game.redealCount >= 1);
  const random = rngFor(options.seed), room = createGame({random, firstSeat: options.firstSeat});
  for (const {action,seat} of game.log) applyAction(room,seat,action,random);
  assert.deepEqual(game.outcomes.map(o => o.settlement), settlements(room.result,room.bid.suit));
  assert.equal(game.outcomes.reduce((sum,o) => sum + o.settlement, 0), 0);
  const own = game.outcomes[room.result.declarer];
  assert.equal(own.win, Number(room.result.won));
  assert.equal(liveUtility(own,'win'), own.win);
  assert.equal(liveUtility(own,'score'), own.settlement / 640);
  assert.ok(Math.abs(liveUtility(own,'balanced') - (.7 * own.win + .3 * own.settlement / 640)) < 1e-12);
});

test('live environment gives detached player views, exact legal masks and a resettable seed', () => {
  const env = createLiveEnv({seed: 698});
  const before = env.observe(0);
  assert.ok(pointsIn(before.hand) > 0);
  before.hand.length = 0;
  assert.equal(env.observe(0).hand.length, 10);
  assert.deepEqual(env.legalActions(1), []);
  assert.throws(() => env.terminalReturns(), /finished/);
  env.step({type: 'bid',points: 14,suit: 'S'});
  for (let i = 0; i < 4; i++) env.step({type:'pass'});
  const declarer = env.observe(0);
  assert.equal(declarer.phase, 'discard');
  const actions = env.legalActions(0);
  assert.equal(actions.length, 286 * declarer.choices.contracts.length);
  assert.ok(actions.every(action => new Set(action.cards).size === 3 && action.cards.every(c => declarer.hand.includes(c))));
  assert.deepEqual(env.observe(2).knownKitty, []);
  assert.equal(declarer.knownKitty.length, 3);
  env.reset();
  assert.deepEqual(env.observe(0), createLiveEnv({seed:698}).observe(0));
});

test('duplicate game comparisons keep each deal intact and rate identical outcomes equally', () => {
  const agents=['legacy','copy','weaker'];
  const config={agents,reference:'legacy',blockSize:2,ridge:.2,bootstrapDraws:16,bootstrapSeed:9,
    reward:{alpha:.7,scoreScale:640},mode:'full'};
  const deals=Array.from({length:4},(_,seed) => agents.flatMap(id => Array.from({length:5},(_,seat) => {
    const lineup=Array(5).fill('heuristic'); lineup[seat]=id;
    const win=Number(seat < 2 + seed%2 && id !== 'weaker');
    return {seed,seat,firstSeat:0,policySeeds:[0,1,2,3,4],lineup,background:'same',agent:id,win,
      role:'opposition',settlement:win?8:-8,partners:[],ms:[.1]};
  })));
  const result=summarizeLive(config,deals);
  assert.equal(result.agents.legacy.winElo,result.agents.copy.winElo);
  assert.deepEqual(result.agents.copy.utilities.win.paired.legacy.ci95,[0,0]);
  assert.equal(result.agents.legacy.inference.decisions,20);
  const broken=structuredClone(deals);
  broken[0][5].firstSeat=1;
  assert.throws(()=>summarizeLive(config,broken),/Unmatched replacement/);
});
