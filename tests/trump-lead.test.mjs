import test from 'node:test';
import assert from 'node:assert/strict';
import {botDecision, botObservation, policyPlay} from '../engine.js';
import {createGame, applyAction} from '../table-deal.js';
import {preferTrumpLead} from '../table-trump-lead.js';
import {rngFor} from '../lab/game.js';
import {contractSearchAction} from '../lab/contract-search.js';
import {balancedTurn, replayBalancedMemory} from '../lab/table-memory.js';
import {decideTableTurn} from '../lab/table-agents.js';

function sixHeartLead() {
  const state = createGame({random:rngFor(32)}), history = [];
  const step = action => {
    if (state.turn === 0) history.push({observation:botObservation(state, 0), action});
    applyAction(state, state.turn, action);
  };
  step({type:'bid', suit:'H', points:14});
  for (let i = 0; i < 4; i++) step({type:'pass'});
  step({type:'discard', cards:['SJ','D10','C10']});
  step({type:'friend', kind:'card', card:'SA'});
  for (const card of ['CA','JK','C6','CQ','CJ']) step({type:'play', card});
  assert.equal(state.turn, 0);
  return {state, view:botObservation(state, 0), history};
}

test('all three policies draw from six hearts headed by A-K-Q after the Joker has fallen', () => {
  const {state, view, history} = sixHeartLead();
  assert.equal(view.lastTrick.cards.length, 0); // The declarer's pile has been covered.
  const memory = replayBalancedMemory(history);
  const proposed = [
    contractSearchAction(view, rngFor(97)),
    balancedTurn(view, rngFor(97), memory).action,
    botDecision(view, policyPlay)
  ];
  const snapshot = structuredClone(view);
  // Both of these off-suit leads were observed in the original table models.
  // Exercise them even if a newer model already chooses to draw trump.
  const pastLeads = ['D7','C9'].map(card => ({type:'play',card}));
  for (const action of [...pastLeads,...proposed]) {
    const choice = preferTrumpLead(view, action);
    assert.deepEqual(choice, {type:'play', card:'HA'});
    assert.doesNotThrow(() => applyAction(structuredClone(state), 0, choice));
  }
  for (const modelId of ['contract_search','recurrent_balanced','heuristic']) {
    const decision = decideTableTurn({modelId, view, seed:97, memory});
    assert.deepEqual(decision.action, {type:'play',card:'HA'});
    if (modelId === 'recurrent_balanced') assert.deepEqual(decision.memory, balancedTurn(view,rngFor(97),memory).memory);
  }
  assert.deepEqual(view, snapshot);
  [state.hands[1][0],state.hands[2][0]] = [state.hands[2][0],state.hands[1][0]];
  assert.deepEqual(botObservation(state,0), snapshot);
});

test('a lead safeguard preserves ordinary singletons, NT, other roles, and reserved special leads', () => {
  const {view} = sixHeartLead(), low = {type:'play',card:'D7'};
  for (const update of [
    {trickNo:1}, {bid:{...view.bid,suit:'N'}}, {selfRole:'friend'}, {selfRole:'opposition'},
    {trick:[{seat:4,card:'DK'}]}, {playedTricks:[]}, {hand:['HA','D7','C9']},
    {hand:['HK','HQ','H7','H5','D7','C9']}, {hand:['HA','HK','H7','H5','D7']},
    {choices:{plays:[{card:'D7'}]}}
  ]) assert.equal(preferTrumpLead({...view,...update}, low), low);
  for (const action of [
    {type:'play',card:'H3'}, {type:'play',card:'JK',suit:'H'},
    {type:'play',card:'SA'}, {type:'play',card:'C3',jokerCall:true}
  ]) assert.equal(preferTrumpLead(view, action), action);
});

test('avoid spending trumps on a known friend and keep useful side-suit entries', () => {
  const {view} = sixHeartLead(), low = {type:'play',card:'D7'};
  const bySeat = cards => cards.map((card, seat) => ({seat,card}));
  const previous = {cards:bySeat(['H2','H4','D4','S8','C7'])};
  const exposed = {...view, trickNo:3, friendKnown:true, friend:1,
    playedTricks:[...view.playedTricks,previous]};
  assert.equal(preferTrumpLead(exposed,low),low);
  // A Mighty discard does not prove that its holder is void in the led suit.
  const notVoid = {...exposed, playedTricks:[...view.playedTricks,
    {cards:bySeat(['H2','H4','D4','SA','C7'])}]};
  assert.equal(preferTrumpLead(notVoid,low).card,'HA');
  assert.equal(preferTrumpLead({...view,call:{kind:'card',card:'DA'}},low),low);
  const ace = {type:'play',card:'DA'};
  assert.equal(preferTrumpLead({...view,hand:[...view.hand,'DA']},ace),ace);
});

test('count buried trumps and face-up tricks before inferring a top trump or outstanding targets', () => {
  const {view} = sixHeartLead(), action = {type:'play',card:'D7'};
  const passed = {cards:['HA','H2','H4','HJ','H9'].map((card,seat)=>({seat,card}))};
  const known = {...view, trickNo:3, hand:['HK','HQ','H10','H7','D7'],
    playedTricks:[...view.playedTricks,passed], discarded:['H3','H5','H6']};
  // Only H8 remains outside. Further drawing can strip partner's last trump.
  assert.equal(preferTrumpLead(known,action),action);
  assert.equal(preferTrumpLead({...known,discarded:['S4','C4','D4']},action).card,'HK');
  // Even A-K-Q is vulnerable when either special could still be with a defender.
  const risk = {...view,call:{kind:'none'},playedTricks:[
    {cards:['CA','C2','C6','CQ','CJ'].map((card,seat)=>({seat,card}))}]};
  assert.equal(preferTrumpLead(risk,action),action);
  assert.equal(preferTrumpLead({...risk,call:{kind:'card',card:'SA'}},action),action);
});

test('keep an entry through the called Mighty suit or a side suit the revealed friend ruffed', () => {
  const {view} = sixHeartLead();
  const smallSpade = {type:'play',card:'S8'}, lowDiamond = {type:'play',card:'D7'};
  const withSpade = {...view, hand:view.hand.map(c => c === 'C9' ? 'S8' : c)};
  assert.equal(preferTrumpLead(withSpade,smallSpade),smallSpade);
  const ruff = {winner:1,cards:['D3','H2','D2','D5','D8'].map((card,seat)=>({seat,card}))};
  const exposed = {...view, trickNo:3, call:{kind:'card',card:'H2'}, friendKnown:true, friend:1,
    hand:view.hand.filter(card=>card!=='D3').map(c=>c==='C9'?'SA':c), playedTricks:[...view.playedTricks,ruff]};
  assert.equal(preferTrumpLead(exposed,lowDiamond),lowDiamond);
  // The same public ruff by an opponent gives the opposite reason to draw.
  assert.equal(preferTrumpLead({...exposed,friend:3,call:{kind:'card',card:'D5'}},lowDiamond).card,'HA');
});
