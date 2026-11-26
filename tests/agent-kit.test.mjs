import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createLiveEnv} from '../lab/live-game.js';
import {checkAgent, legalAction, runAgent, turnRequest} from '../agent-kit/protocol.js';
import starter from '../agent-kit/starter.js';

test('v1 seat input keeps private cards, identities and room data outside other seats', () => {
  const env = createLiveEnv({seed:77});
  env.step({type:'bid', suit:'H', points:14});
  for (let i = 0; i < 4; i++) env.step({type:'pass'});
  const own = turnRequest(env.observe(0), 17);
  assert.equal(own.observation.knownKitty.length, 3);
  env.step({type:'discard', cards:own.observation.hand.slice(0, 3)});
  env.step({type:'friend', kind:'card', card:'SA'});
  const view = env.observe(1);
  view.bidHistory[0].name = '개인 별명';
  const req = turnRequest({...view, hands:[['SA']], account:'private', knownKitty:['JK'], discarded:['SA']}, 17);
  assert.equal(req.apiVersion, 1);
  assert.equal(req.seed, 17);
  assert.equal(req.observation.friend, null);
  assert.deepEqual(req.observation.knownKitty, []);
  assert.deepEqual(req.observation.discarded, []);
  for (const field of ['hands','account','seed']) assert.equal(field in req.observation, false);
  assert.equal('name' in req.observation.bidHistory[0], false);
  req.observation.hand.pop();
  assert.equal(view.hand.length, 10);
});

test('a model cannot make an illegal move legal by editing its copy of the choices', () => {
  const env = createLiveEnv({seed:83});
  const view = env.observe(env.turn);
  const invalid = {...starter, decide({observation}) {
    observation.choices.bids.push({suit:'X', points:99});
    return {type:'bid', suit:'X', points:99};
  }};
  assert.throws(() => runAgent(invalid, view, 2), /유효한 수/);
  assert.throws(() => checkAgent({...starter, apiVersion:2}));
  assert.throws(() => checkAgent({...starter, id:'random'}));
  assert.throws(() => runAgent({...starter, decide:async () => ({type:'pass'})}, view, 2), /동기/);
  env.step({type:'bid', suit:'H', points:14});
  for (let i = 0; i < 4; i++) env.step({type:'pass'});
  const discard = env.observe(env.turn);
  assert.equal(legalAction(discard,{type:'discard', cards:Array(3).fill(discard.hand[0])}), null);
  assert.equal(legalAction(discard,{type:'discard', cards:discard.hand.slice(0,3), contract:{suit:'D',points:14}}), null);
});

test('JSON line environment replays the real table to settlement and recovers from a bad move', () => {
  const env = createLiveEnv({seed:182});
  const input = [{op:'reset', seed:182}, {op:'step',action:{type:'discard',cards:[]}}];
  while (!env.done) {
    const action = runAgent(starter, env.observe(env.turn), 33);
    input.push({op:'step', action});
    env.step(action);
  }
  const script = fileURLToPath(new URL('../agent-kit/environment.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [script], {input:input.map(row => JSON.stringify(row)).join('\n'), encoding:'utf8'});
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, input.length);
  assert.ok(replies[1].error);
  assert.deepEqual(replies.slice(2).filter(row => row.error), []);
  assert.deepEqual(replies.at(-1).outcomes, env.terminalReturns());
});
