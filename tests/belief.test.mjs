import {test} from 'node:test';
import assert from 'node:assert/strict';
import {botObservation,DECK,pointsIn} from '../engine.js';
import {position} from '../lab/belief-experiment.mjs';
import {worldSampler} from '../lab/belief.js';
import {assessMove,pairedGain,summary} from '../lab/belief-policy.js';

test('accepted joint draws reconstruct root private history, legal choices and card capacities',()=>{
  let observedDeclarer=false,observedDefender=false;
  for(let i=0;i<14;i++){
    const p=position(90531+i,1+i%9,{withHistory:true});
    const v=p.observation, draw=worldSampler(v,{seed:200+i,withHistory:true});
    for(let k=0;k<2;k++){
      const world=draw.sample(250);
      assert.ok(world);
      const s=world.state;
      assert.deepEqual(botObservation(s,v.seat),v);
      assert.deepEqual(s.hands.map(h=>h.length),v.counts);
      const cards=[...s.hands.flat(),...s.discarded,...s.trick.map(p=>p.card),
        ...s.playedTricks.flatMap(t=>t.cards.map(p=>p.card))];
      assert.deepEqual(new Set(cards),new Set(DECK));
      assert.equal(cards.length,53);
      const actual=p.histories[v.seat], reconstructed=world.histories[v.seat];
      assert.deepEqual(reconstructed.map(h=>h.observation),actual.map(h=>h.observation));
      const first=world.histories.map(h=>h.find(row=>row.observation.phase==='bid')?.observation.hand).filter(Boolean);
      assert.ok(first.every(h=>h.length===10&&pointsIn(h)>0));
      if(v.seat===v.declarer) {
        observedDeclarer=true; assert.deepEqual(s.knownKitty,v.knownKitty);assert.deepEqual(s.discarded,v.discarded);
      } else observedDefender=true;
    }
  }
  assert.ok(observedDeclarer && observedDefender);
});

test('same information set and seed regenerate identical worlds and action values',()=>{
  const p=position(300221,8,{branch:true}), v=p.observation;
  const alternative=worldSampler(v,{seed:669}).sample().state;
  assert.notDeepEqual(alternative.hands,p.state.hands);
  const clone=botObservation(alternative,v.seat);
  const opts={objective:'score',selectN:5,confirmN:8,seed:82};
  const first=assessMove(v,opts), second=assessMove(clone,opts);
  assert.deepEqual(first,second);
  assert.equal(first.actions.length,v.choices.plays.length);
  for(const a of first.actions) {assert.equal(a.selection.n,5);assert.equal(a.confirmation.n,8);}
  assert.notEqual(first.seed,first.confirmationSeed);
  assert.equal(first.sampler.selection.accepted,5);
});

test('friend declaration is evaluated from declarer private exchange history',()=>{
  const p=position(13123,3,{withHistory:true});
  const v=p.histories[p.observation.declarer].find(e=>e.observation.phase==='friend').observation;
  const world=worldSampler(v,{seed:1,withHistory:true}).sample();
  assert.deepEqual(botObservation(world.state,v.seat),v);
  const report=assessMove(v,{objective:'win',selectN:1,confirmN:1});
  assert.equal(report.actions.length,v.choices.friends.length);
  assert.ok(report.actions.some(({action})=>action.kind==='first'));
  assert.ok(report.actions.some(({action})=>action.kind==='none'));
  assert.equal(report.decision,'판단 보류');
});

test('paired sample loss averages per action before comparing, retaining common-world covariance',()=>{
  // The first action succeeds in 3 of 4 equally likely worlds. Hindsight
  // would choose a different action in the fourth world and incorrectly score 1.
  const rows=[[1,1,1,0],[0,0,0,1]];
  assert.equal(Math.max(...rows.map(x=>summary(x).mean)),.75);
  const gain=pairedGain(rows,0,1);
  assert.equal(gain.mean,.5); assert.equal(gain.se,.5);
  assert.ok(gain.ci95[0]<0 && gain.ci95[1]>0);
  assert.equal(pairedGain(rows,1,1).mean,0);
});
