import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rngFor} from '../lab/game.js';
import {statistics,virtualMatches,fitRatings} from '../lab/ratings.mjs';
import {checkClusters} from '../lab/rate.mjs';
import {freezeRoster,playScenario,scenarioFor} from '../lab/evaluate.mjs';

const config = JSON.parse(readFileSync(new URL('../configs/benchmark.json',import.meta.url)));
test('one scenario replays all five seats from common seeds even with a stochastic opponent', async()=>{
  const roster=['heuristic','copy'];
  const manifest={...config,agents:roster,splits:{validation:{startSeed:1640101,scenarios:1}},backgroundCycle:{validation:['mixed']}};
  const ids=[...new Set(['heuristic',...manifest.backgrounds.mixed])];
  const {act,hashes}=await freezeRoster(ids);
  const meta={config:manifest,benchmark_version:'test',split:'validation',hashes:{...hashes,copy:hashes.heuristic}};
  const policy=(id,view,rng)=>act(id==='copy'?'heuristic':id,view,rng);
  const rows=playScenario(0,meta,policy);
  const [totals]=checkClusters(rows,meta);
  assert.deepEqual(totals[0],totals[1]);
  for(let seat=0;seat<5;seat++){
    const pair=rows.filter(r=>r.focal_seat===seat).map(({elapsed_time,inference_ms,agent,...r})=>r);
    assert.deepEqual(pair[0],pair[1]);
  }
  assert.throws(()=>checkClusters([...rows.slice(1),rows[1]],meta));
  const broken=structuredClone(rows);
  broken[0].policy_rng_seeds=[11,22,33,44,55];
  assert.throws(()=>checkClusters(broken,meta),/Unmatched/);
});

test('roster ratings use exact integer differences before computing ties and pin reference',()=>{
  const ids=['A','B','C'];
  const cases=[[[5,0],[1,10],[0,-4]],[[0,0],[4,10],[0,-6]]];
  const win=virtualMatches(cases,ids,2,0),score=virtualMatches(cases,ids,2,1);
  const ab=win.find(v=>v.a==='A'&&v.b==='B');
  assert.deepEqual([ab.wins,ab.ties,ab.losses],[0,1,0]);
  const wr=fitRatings(ids,win,'A'),sr=fitRatings(ids,score,'A');
  assert.equal(wr.A,1500);assert.equal(sr.A,1500);assert.equal(fitRatings(['A','B'],[ab],'A').B,1500);
  assert.ok(sr.B>sr.A && sr.C<sr.A && Number.isFinite(wr.C));
  assert.throws(()=>fitRatings(ids,[ab],'A'),/disconnected/);
});

test('the five seats from each shared deal move jointly in every bootstrap draw',()=>{
  const cfg={reference:'R',blockSize:1,ridge:.2,bootstrapDraws:256};
  const games=[[[5,0],[0,0]],[[0,0],[5,0]]];
  const result=statistics(games,['R','B'],cfg,rngFor(2026)).agents.B;
  assert.deepEqual(result.winDifference.ci95,[-1,1]); // two draws, not ten independent seats
  assert.deepEqual(result.scoreDifference100.ci95,[0,0]);
  assert.deepEqual(result.scoreElo.ci95,[1500,1500]);
});

test('evaluation seeds, held-out composition and final seat order are fixed before games',()=>{
  const validation=config.splits.validation, final=config.splits.final_test;
  assert.ok(validation.startSeed>=1000000 && validation.startSeed+validation.scenarios<final.startSeed);
  assert.ok(final.startSeed>=2000000);
  assert.ok(!config.backgroundCycle.validation.includes('heldout_search'));
  assert.ok(config.backgroundCycle.final_test.includes('heldout_search'));
  const s=scenarioFor(config,'final_test',3);
  assert.equal(s.composition,'heldout_search');
  assert.equal(new Set(s.policySeeds).size,5);
  assert.equal(s.firstSeat,3);
  assert.deepEqual(s,scenarioFor(config,'final_test',3));
});
test('objective deltas compare the learned seat with the same utility applied to the reference',()=>{
  const cfg={reference:'R',blockSize:1,ridge:.2,bootstrapDraws:16};
  const scenarios=[[[5,-4,-1],[0,4,1]],[[0,8,3],[5,-8,-3]]];
  const m=statistics(scenarios,['R','B'],cfg,rngFor(4),['mixed','heldout'],{B:2}).agents.B;
  assert.equal(m.objective.value,-.2);
  assert.deepEqual(m.objectiveDifference.ci95,[-.4,-.4]); // one independent cluster per fixed background
  assert.equal(m.winDifference.value,0);
});
