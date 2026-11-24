import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {applyAction, botObservation, createGame, leadSuit, mighty, winningPlay} from '../engine.js';
import {chooseModelAction, MODEL_CATALOG} from '../lab/agents.js';
import {freezeRoster} from '../lab/evaluate.mjs';
import {rngFor} from '../lab/game.js';
import {protectPartner} from '../lab/partnership-policy.js';
import {ruleAction} from '../lab/rules-agents.js';
import {rulesHash} from '../lab/version.mjs';

const ids = MODEL_CATALOG.map(m => m.id);
const archive = JSON.parse(readFileSync(new URL('../lab/results-v2/final_test.manifest.json', import.meta.url)));
const old = await freezeRoster(ids, archive.config.searchPolicy);
const current = await freezeRoster(ids);

// Replay complete, legal deals. The fixture holder keeps the Mighty until the
// specified decision so late-game situations remain available for inspection.
function position(seed, trickNo, played, {trump = 'H', call = {kind:'card',card:mighty(trump)}, jokerCall = false} = {}) {
  const state = createGame({random:rngFor(seed), rules:{allowFirstJokerCall:jokerCall}});
  const step = action => applyAction(state, state.turn, action);
  const view = () => botObservation(state, state.turn);
  step({type:'bid',points:14,suit:trump});
  for(let i = 0; i < 4; i++) step({type:'pass'});
  step(ruleAction('heuristic', view()));
  step({type:'friend', ...call});
  while (state.trickNo !== trickNo || state.trick.length !== played) {
    const v = view();
    let action = ruleAction('heuristic', v);
    const lower = v.choices.plays.find(p => p.card !== mighty(trump) && p.card !== 'JK');
    if (action.card === mighty(trump) && lower) action = {type:'play', ...lower};
    step(action);
  }
  return {state, step, view};
}

test('a hidden friend ducks the declarer’s opening ace, in the browser and frozen evaluation roster', () => {
  const {state, view} = position(225,1,1);
  const v = view(), original = structuredClone(v);
  assert.deepEqual(v.trick, [{seat:v.declarer,card:'DA'}]);
  assert.equal(v.selfRole,'friend');
  assert.equal(v.friendKnown,false);
  assert.equal(v.friend,null);
  assert.equal(old.act('legacy',v).card,'SA');
  assert.equal(chooseModelAction('legacy',v).card,'D8');
  for (const id of ids) {
    const action = chooseModelAction(id,v,rngFor(28));
    assert.deepEqual(action, current.act(id,v,rngFor(28)));
    if (id === 'random') assert.deepEqual(action, old.act(id,v,rngFor(28)));
    else assert.notEqual(action.card,'SA');
  }
  assert.deepEqual(v,original);
  [state.hands[3][0],state.hands[4][0]] = [state.hands[4][0],state.hands[3][0]];
  assert.deepEqual(view(),v);
  assert.deepEqual(chooseModelAction('legacy',view()),chooseModelAction('legacy',v));
});

test('keep the Mighty when partner has won the last seat; take a vulnerable lead when a later defender can ruff', () => {
  const safe = position(180,9,4).view();
  assert.equal(winningPlay(safe).seat, safe.declarer);
  assert.deepEqual(safe.hand,['SA','D3']);
  assert.equal(old.act('legacy',safe).card,'SA');
  assert.equal(chooseModelAction('legacy',safe).card,'D3');

  const {state, view} = position(110,6,2);
  const risk = view(), lead = leadSuit(risk.trick);
  assert.equal(winningPlay(risk).seat, risk.declarer);
  assert.equal(lead,'S');
  const defender = [3,4].find(seat => !state.hands[seat].some(c => c[0] === lead) &&
    state.hands[seat].some(c => c[0] === risk.bid.suit));
  assert.ok(defender !== undefined);
  assert.ok(risk.playedTricks.some(t => leadSuit(t.cards) === lead &&
    t.cards.some(p => p.seat === defender && p.card[0] === risk.bid.suit)));
  assert.equal(protectPartner(risk),risk);
  assert.equal(chooseModelAction('legacy',risk).card,'SA');
});

test('an enemy declarer, an unresolved first-trick friend, and a forced Joker call retain their full choices', () => {
  for (const call of [{kind:'none'},{kind:'first'},{kind:'card',card:'C2'}]) {
    const v = position(225,1,1,{call}).view();
    assert.notEqual(v.selfRole,'friend');
    assert.equal(protectPartner(v),v);
  }
  const call = position(11,1,0,{trump:'S',jokerCall:true});
  call.step({type:'play',card:'C3',jokerCall:true});
  const v = call.view();
  assert.equal(v.selfRole,'friend');
  assert.deepEqual(v.choices.plays.map(p => p.card).sort(),['DA','JK']);
  assert.equal(protectPartner(v),v);
});

test('all public roles recognize a teammate winning the final seat of a trick', () => {
  for (const [seed, trickNo, role, teammate] of [[104,2,'opposition',2],[114,9,'friend',0],[142,7,'declarer',4]]) {
    const v = position(seed,trickNo,4,{call:{kind:'card',card:'DA'}}).view();
    assert.equal(v.selfRole,role);
    assert.equal(v.friendKnown,true);
    assert.equal(winningPlay(v).seat,teammate);
    assert.ok(v.choices.plays.some(p => p.card === 'SA'));
    assert.ok(protectPartner(v).choices.plays.every(p => p.card !== 'SA'));
  }
});

test('archived policy hashes and engine rules still reproduce before the partnership adjustment', () => {
  assert.equal(rulesHash,archive.rulesHash);
  assert.deepEqual(old.hashes,archive.hashes);
  assert.notEqual(current.hashes.legacy,old.hashes.legacy);
  assert.equal(current.hashes.random,old.hashes.random);
});
