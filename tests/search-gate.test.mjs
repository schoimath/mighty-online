import test from 'node:test';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import model from '../lab/artifacts/recurrent-aux/best-balanced.json' with {type:'json'};
import {createRecurrentPolicy} from '../lab/recurrent.js';
import {createGatedRecurrentPolicy} from '../lab/gated-recurrent.js';
import training from '../lab/results-live/trained-table/search-gate-training.json' with {type:'json'};
import {gatedPlay,searchGateFeatures,searchGateScore,searchTeacher} from '../lab/search-gate.js';
import {applyAction,createGame} from '../table-deal.js';
import {botDecision,botObservation,policyPlay} from '../engine.js';
import {rngFor} from '../lab/game.js';
import {playLiveEpisode} from '../lab/live-game.js';
import {withJokerStatus} from '../table-joker.js';
import {conserveMightyOnTrumpAce,conserveOpeningJoker} from '../table-tactics.js';
import {preferTrumpLead} from '../table-trump-lead.js';

test('search routing preserves seat memory from the auction through the last trick',()=>{
  const {searchGate,endgame,...original}=model;
  const weights=Array(20).fill(0), phases=new Set();
  let different=0, searches=0;
  const policies=Array.from({length:5},()=>{
    const base=createRecurrentPolicy(original,'balanced');
    const off=createGatedRecurrentPolicy({...original,searchGate:{weights,threshold:1}},'balanced');
    const on=createGatedRecurrentPolicy({...original,searchGate:{weights,threshold:0}},'balanced');
    return (raw,rng)=>{
      const view=conserveMightyOnTrumpAce(conserveOpeningJoker(withJokerStatus(raw)));
      const action=base(view,rng), active=on(view,rng);
      assert.deepEqual(off(view,rng),action);
      assert.deepEqual(on.getMemory(),base.getMemory());
      assert.deepEqual(off.getMemory(),base.getMemory());
      phases.add(view.phase);
      if(view.phase==='play' && view.choices.plays.length>1) {
        assert.deepEqual(active,searchTeacher(view));
        different+=Number(!isDeepStrictEqual(action,active));
        searches++;
      } else assert.deepEqual(active,action);
      return preferTrumpLead(raw,action);
    };
  });
  playLiveEpisode({seed:32490017,policies});
  assert.deepEqual([...phases],['bid','discard','friend','play']);
  assert.ok(searches>0 && different>0);
});

test('an active search gate cannot distinguish two compatible hidden hands',()=>{
  const gate=training.searchGate;
  const guarded=state=>conserveMightyOnTrumpAce(conserveOpeningJoker(withJokerStatus(botObservation(state,state.turn))));
  const rng=rngFor(32490019), state=createGame({random:rng});
  const actors=Array.from({length:5},()=>createRecurrentPolicy(model,'balanced'));
  while(!state.result) {
    const view=guarded(state), proposal=actors[state.turn](view,rng);
    if(view.phase==='play' && view.trickNo===7 && view.seat!==0 && view.seat!==3 &&
        view.choices.plays.length>1 && state.hands[0].includes('S6') && state.hands[3].includes('S5')) {
      const features=searchGateFeatures(view,proposal);
      if(searchGateScore(gate.weights,features)>=gate.threshold) {
        // Exchanging two unplayed low spades preserves observed voids, the
        // ownership of the called friend, and every original hand's point count.
        assert.ok(!['S5','S6'].includes(view.call?.card));
        const alt=structuredClone(state);
        alt.hands[0][alt.hands[0].indexOf('S6')]='S5';
        alt.hands[3][alt.hands[3].indexOf('S5')]='S6';
        const other=guarded(alt);
        assert.notDeepEqual(state.hands,alt.hands);
        assert.deepEqual(view,other);
        assert.deepEqual(searchGateFeatures(other,proposal),features);
        const action=gatedPlay(gate,view,proposal);
        assert.deepEqual(gatedPlay(gate,other,proposal),action);
        assert.ok(view.choices.plays.some(m=>m.card===action.card && m.suit===action.suit && !!m.jokerCall===!!action.jokerCall));
        return;
      }
    }
    applyAction(state,state.turn,preferTrumpLead(view,botDecision(view,policyPlay)),rng);
  }
  assert.fail('Expected a late search and two exchangeable private cards');
});
