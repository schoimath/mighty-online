import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {applyAction, botObservation, createGame, mighty} from '../engine.js';
import {chooseModelAction} from '../lab/agents.js';
import {freezeRoster} from '../lab/evaluate.mjs';
import {rngFor} from '../lab/game.js';
import {ruleAction} from '../lab/rules-agents.js';
import {SEARCH_POLICY_VERSION} from '../lab/search-policy.js';

// All seeded snapshots below are reached by legitimate moves from full deals.
function round(seed, trump, jokerCall = false) {
  const state = createGame({random:rngFor(seed), rules:{allowFirstJokerCall:jokerCall}});
  const step = action => applyAction(state,state.turn,action);
  step({type:'bid',points:14,suit:trump});
  for (let i=0; i<4; i++) step({type:'pass'});
  const keep = ['JK',mighty(trump)];
  if (jokerCall) keep.push('C3');
  step({type:'discard',cards:state.hands[state.turn].filter(c => !keep.includes(c)).slice(0,3)});
  step({type:'friend',kind:'none'});
  return {state, step, view:() => botObservation(state,state.turn)};
}

test('search keeps the Joker behind both versions of the Mighty and on ordinary first tricks', async () => {
  const {hashes,act} = await freezeRoster(['legacy'],SEARCH_POLICY_VERSION);
  const archive = JSON.parse(readFileSync(new URL('../lab/results/final_test.manifest.json',import.meta.url)));
  const old = await freezeRoster(['legacy'],archive.config.searchPolicy ?? 'v1');
  assert.equal(old.hashes.legacy,archive.hashes.legacy);
  assert.notEqual(hashes.legacy,old.hashes.legacy);
  const cases = [
    [10,'H',false,['SA']],
    [8,'S',true,['DA']],
    [5,'H',false,['C2','CK','SQ','CQ']],
    [2,'H',false,['S2','S6','H7','SK','SJ','H4','SA']]
  ];
  for (const [seed,trump,call,opening] of cases) {
    const deal = round(seed,trump,call);
    for (const card of opening) deal.step({type:'play',card});
    const before = deal.view(), options = structuredClone(before.choices.plays);
    assert.equal(before.selfRole,'opposition');
    assert.equal(old.act('legacy',before).card,'JK');
    const play = chooseModelAction('legacy',before);
    assert.deepEqual(act('legacy',before),play);
    assert.notEqual(play.card,'JK');
    assert.deepEqual(before.choices.plays,options);
    deal.step(play);
    assert.ok(deal.state.hands[before.seat].includes('JK'));
  }
});

test('opening a trick and a forced response still use legal cards and respect Joker calls', () => {
  const opener = round(1,'H',true);
  assert.ok(opener.view().hand.includes('JK'));
  assert.notEqual(chooseModelAction('legacy',opener.view()).card,'JK');
  // With nine trumps and the Joker, the only legal opening lead is the Joker.
  const forced = structuredClone(opener.state);
  const firstHand = ['H2','H3','H4','H5','H6','H7','H8','H9','H10','JK'];
  const rest = [...forced.hands.flat(), ...forced.discarded].filter(c => !firstHand.includes(c));
  forced.hands = [firstHand,...Array.from({length:4},(_,i)=>rest.slice(i*10,i*10+10))];
  forced.discarded = rest.slice(40);
  assert.equal(chooseModelAction('legacy',botObservation(forced,0)).card,'JK');
  for (const [trump, expected] of [['H',['JK']],['S',['DA','JK']]]) {
    const deal = round(11,trump,true);
    deal.step({type:'play',card:'C3',jokerCall:true});
    const view = deal.view();
    assert.deepEqual(view.choices.plays.map(p=>p.card).sort(),expected);
    const move = chooseModelAction('legacy',view);
    assert.deepEqual(move,ruleAction('legacy',view));
    deal.step(move);
  }
});

test('a live Joker can still win points after the opening trick', () => {
  const deal = round(2,'H',true);
  while (deal.state.trickNo < 2 || !deal.state.trick.length) {
    const v=deal.view();
    const special = !v.trick.length && (v.trickNo===1 && v.choices.plays.find(p=>p.card==='SA') ||
      v.choices.plays.find(p=>p.jokerCall));
    deal.step(special ? {type:'play',...special} : ruleAction('heuristic',v));
  }
  const view = deal.view();
  assert.deepEqual(view.trick.map(p=>p.card),['C10']);
  assert.ok(view.choices.plays.length > 1);
  assert.equal(chooseModelAction('legacy',view).card,'JK');
});
