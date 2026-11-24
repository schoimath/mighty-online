import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,botObservation,ratedPlays} from '../engine.js';
import {playEpisode,rngFor} from '../lab/game.js';
import {ruleAction} from '../lab/rules-agents.js';
import {decisionGroup,distribution,INPUT_SIZE,ACTION_SIZE} from '../lab/policy.js';

const zero={context:[Array(INPUT_SIZE).fill(0)],contextBias:[0],
  actor:Array.from({length:ACTION_SIZE},()=>[0]),actorBias:Array(ACTION_SIZE).fill(0),critic:[0],criticBias:0};

test('residual logits remain finite on ordinary trick leads and every action stage',()=>{
  const seen=new Set();
  for(let seed=1;seed<=4;seed++){
    playEpisode({seed,policies:Array.from({length:5},()=> (v,r)=>{
      const action=ruleAction('heuristic',v,r);
      const groups=[decisionGroup(v)];
      if(v.phase==='discard')groups.push(decisionGroup(v,action.contract||v.bid));
      if(v.phase==='play' && !v.trick.length){
        assert.ok(ratedPlays(v).every(opt=>Number.isFinite(opt.value)));
        seen.add('lead');
      }
      for(const g of groups){
        seen.add(v.phase);
        assert.equal(g.state.length,INPUT_SIZE);
        assert.ok(g.features.every(f=>f.length===ACTION_SIZE));
        assert.ok(g.state.every(Number.isFinite));
        const {probs}=distribution(zero,g);
        assert.ok(probs.every(p=>p>0&&p<=1));
        assert.ok(Math.abs(probs.reduce((a,b)=>a+b,0)-1)<1e-9);
        assert.ok(g.choices[g.teacher]);
        if(g.choices[0].type==='discard') {
          assert.equal(g.choices.length,286);
          assert.equal(new Set(g.choices.map(a=>a.cards.slice().sort().join('.'))).size,286);
        }
      }
      return action;
    })});
  }
  assert.deepEqual(seen,new Set(['bid','discard','friend','play','lead']));
});

test('hidden hand and kitty replacements preserve candidate vectors and action distribution',()=>{
  const a=createGame({random:rngFor(19)}), b=structuredClone(a);
  [b.hands[1][0],b.hands[4][2]]=[b.hands[4][2],b.hands[1][0]];
  [b.hands[2][4],b.kitty[0]]=[b.kitty[0],b.hands[2][4]];
  const inputs=[a,b].map(s=>decisionGroup(botObservation(s,0)));
  assert.deepEqual(inputs[0],inputs[1]);
  assert.deepEqual(distribution(zero,inputs[0]),distribution(zero,inputs[1]));
});
