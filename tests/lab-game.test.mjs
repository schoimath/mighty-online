import assert from 'node:assert/strict';
import test from 'node:test';
import {createGame, applyAction, botObservation, DEFAULT_RULES} from '../engine.js';
import {playEpisode,rngFor} from '../lab/game.js';
import {ruleAction} from '../lab/rules-agents.js';
import {outcomes,settlements,SCORE_SCALE,utility} from '../lab/scoring.js';
import {analyzeEndgame,endgameWorlds,expectedLoss} from '../lab/diagnostic.mjs';
import {readFileSync} from 'node:fs';

test('the rule preset matches the actual room; payouts are zero-sum and their sharp uniform bound is 640',()=>{
  const spec=JSON.parse(readFileSync(new URL('../configs/rules.json',import.meta.url)));
  assert.deepEqual(spec.defaults,DEFAULT_RULES);
  let bound=0;
  for(let target=13;target<=20;target++) for(let points=0;points<=20;points++)
    for(const friend of [null,0,3]) for(const trump of ['N','C']) {
      const r={won:points>=target,points,target,declarer:2,friend};
      const v=settlements(r,trump);
      assert.equal(v.reduce((a,b)=>a+b,0),0);
      bound=Math.max(bound,...v.map(Math.abs));
    }
  assert.equal(bound,SCORE_SCALE);assert.equal(bound,spec.scoring.scale);
  const net=(points,friend,suit='H')=>settlements({points,target:15,won:points>=15,declarer:0,friend},suit);
  assert.deepEqual(net(15,1),[10,5,-5,-5,-5]);
  assert.deepEqual(net(14,1),[-2,-1,1,1,1]);
  assert.deepEqual(net(20,null,'N'),[320,-80,-80,-80,-80]);
  assert.deepEqual(net(5,null,'N'),[-320,80,80,80,80]);
  // A zero-money win checks independence of W from the sign of S.
  const state={result:{points:10,target:10,won:true,declarer:0,friend:1},bid:{suit:'C'},captured:[[],[],[],[],[]]};
  assert.equal(outcomes(state)[1].win,1);
  assert.equal(outcomes(state)[1].settlement,0);
  const o={win:1,settlement:-320};assert.equal(utility('win',o),1);
  assert.equal(utility('score',o),-.5);assert.equal(utility('balanced',o,{alpha:.25}),-.125);
  assert.equal(utility('downside_averse',o,{lambdaRisk:.5}),-.625);
});

test('identical deal and seat streams reproduce every action even across all-pass redeals',()=>{
  const ids=['heuristic','random','aggressive','conservative','random'];
  const policies=ids.map(id=>(v,r)=>v.phase==='bid' && v.dealNo===1 ? {type:'pass'} : ruleAction(id,v,r));
  const args={seed:47228,firstSeat:1,policies,record:true};
  const run=playEpisode(args);
  assert.deepEqual(run,playEpisode(args));assert.ok(run.redealCount>=1);
  assert.throws(()=>playEpisode({...args,maxRedeals:0}),/Redeal/);
  const dealRandom=rngFor(args.seed), state=createGame({firstSeat:args.firstSeat,random:dealRandom});
  for(const {seat,action} of run.log) applyAction(state,seat,action,dealRandom);
  assert.deepEqual(outcomes(state),run.outcomes);
  assert.equal(state.playedTricks.length,10);
  const cards=state.playedTricks.flatMap(t=>t.cards.map(p=>p.card)).concat(state.discarded);
  assert.equal(cards.length,53);assert.equal(new Set(cards).size,53);
  assert.equal(state.scores.reduce((a,b)=>a+b),20);
  assert.equal(run.outcomes.reduce((sum,p)=>sum+p.captured,0),20-state.discarded.filter(c=>/10|[JQKA]$/.test(c)&&c!=='JK').length);
});

test('same legal observations in different deals produce identical rules policies and distributions',()=>{
  const {states,seat,observation}=endgameWorlds({seed:30,trick:8});
  assert.notDeepEqual(states[0].hands,states[1].hands);
  assert.deepEqual(botObservation(states[1],seat),observation);
  for(const id of ['random','heuristic','conservative','aggressive','legacy']){
    assert.deepEqual(ruleAction(id,observation,rngFor(52)),ruleAction(id,botObservation(states[1],seat),rngFor(52)));
  }
  for(let s=0;s<5;s++) {
    const view=botObservation(states[0],s);
    assert.equal(view.knownKitty.length,s===states[0].declarer?3:0);
    assert.equal(view.discarded.length,s===states[0].declarer?3:0);
    for(const privateKey of ['hands','kitty','botModels','rng','seed'])assert.equal(privateKey in view,false);
  }
});

test('a rational 70% choice incurs zero loss despite losing in the other world',()=>{
  assert.deepEqual(expectedLoss([[1,0],[0,1]],[.7,.3],0),{values:[.7,.3],loss:0});
  const p = analyzeEndgame({seed:355,trick:8,weights:[.7,.3]},v=>ruleAction('heuristic',v),'win');
  assert.ok(p.worldUtilities.some(row=>row[0]!==row[1]));
  assert.ok(p.worldUtilities.some(a=>p.worldUtilities.some(b=>a[0]>b[0]&&a[1]<b[1])));
  assert.equal(p.loss,0);
});
