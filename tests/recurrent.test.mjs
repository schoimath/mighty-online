import test from 'node:test';
import assert from 'node:assert/strict';
import {botObservation,createGame,applyAction} from '../engine.js';
import {rngFor} from '../lab/game.js';
import {actionSize,createRecurrentPolicy,inputSize,recurrentDistribution,recurrentGroup,
  recurrentSchema,replayRecurrentMemory} from '../lab/recurrent.js';

const values=(n,k)=>Array.from({length:n},(_,i)=>.02*Math.sin(i+k));
const model={schema:recurrentSchema,hidden:2,input:Array.from({length:6},(_,k)=>values(inputSize+3,k)),
  inputBias:values(6,3),recurrent:Array.from({length:6},(_,k)=>values(2,k)),recurrentBias:values(6,8),
  actor:Array.from({length:actionSize},(_,k)=>values(2,k+3)),actorBias:values(actionSize,4),
  critic:[.02,-.1],criticBias:.1};

test('same information history preserves GRU input, mask, memory and action probabilities',()=>{
  const a=createGame({random:rngFor(19)}), b=structuredClone(a);
  [b.hands[1][0],b.hands[4][2]]=[b.hands[4][2],b.hands[1][0]];
  [b.hands[2][4],b.kitty[0]]=[b.kitty[0],b.hands[2][4]];
  let memories=[null,null];
  for(const count of [0,1]){
    const groups=[a,b].map(s=>recurrentGroup(botObservation(s,0)));
    assert.deepEqual(groups[0],groups[1]);
    assert.equal(groups[0].state.length,inputSize);
    const dist=groups.map((g,i)=>recurrentDistribution(model,g,memories[i],'balanced'));
    assert.deepEqual(dist[0],dist[1]);
    memories=dist.map(d=>d.hidden);
    if(count===0) for(const s of [a,b]){
      applyAction(s,0,{type:'bid',suit:'S',points:14});
      applyAction(s,1,{type:'bid',suit:'H',points:15});
      for(const seat of [2,3,4]) applyAction(s,seat,{type:'pass'});
    }
  }
});

test('GRU state is private to the seat, restorable across workers, and resets on a redeal',()=>{
  const game=createGame({random:rngFor(23)});
  const first=botObservation(game,0);
  const a=createRecurrentPolicy(model,'win'), b=createRecurrentPolicy(model,'win');
  const action=a(first);
  assert.equal(b.getMemory(),null);
  const h=a.getMemory();
  assert.deepEqual(h,replayRecurrentMemory(model,'win',[{observation:first,action}]));
  const worker=createRecurrentPolicy(model,'win');
  worker.restoreMemory(h);
  h[0]+=12;
  assert.deepEqual(worker.getMemory(),a.getMemory());
  assert.deepEqual(worker(first),a(first));
  for(const seat of [0,1,2,3,4]) applyAction(game,seat,{type:'pass'},rngFor(82));
  const next=botObservation(game,game.turn);
  assert.deepEqual(a(next),b(next));
  assert.deepEqual(a.getMemory(),b.getMemory());
  const fresh=createRecurrentPolicy(model,'win');
  assert.equal(fresh.getMemory(),null);
});

test('discard history uses the realized contract for its second decision',()=>{
  const game=createGame({random:rngFor(131)});
  applyAction(game,0,{type:'bid',points:14,suit:'H'});
  for(let seat=1;seat<5;seat++) applyAction(game,seat,{type:'pass'});
  const observation=botObservation(game,0);
  const revised=observation.choices.contracts.find(c=>c.suit==='D');
  const g1=recurrentGroup(observation), g2=recurrentGroup(observation,revised);
  const m1=recurrentDistribution(model,g1,null,'score').hidden;
  assert.deepEqual(replayRecurrentMemory(model,'score',[{observation,action:{contract:revised}}]),
    recurrentDistribution(model,g2,m1,'score').hidden);
  assert.equal(g2.choices.length,286);
});

test('unrevealed friend and different buried cards leave the same defender history and GRU unchanged',()=>{
  const game=createGame({random:rngFor(78)});
  applyAction(game,0,{type:'bid',points:14,suit:'H'});
  const passView=botObservation(game,1);
  for(let i=1;i<5;i++) applyAction(game,i,{type:'pass'});
  const other=structuredClone(game), called=game.hands[2][0];
  [other.hands[2][0],other.hands[3][0]]=[other.hands[3][0],other.hands[2][0]];
  for(const [i,s] of [game,other].entries()){
    applyAction(s,0,{type:'discard',cards:s.hands[0].slice(i,i+3)});
    applyAction(s,0,{type:'friend',kind:'card',card:called});
  }
  assert.notEqual(game.friend,other.friend);
  assert.notDeepEqual(game.discarded,other.discarded);
  const common=botObservation(game,0).choices.plays.find(p=>
    botObservation(other,0).choices.plays.some(q=>p.card===q.card && p.suit===q.suit && p.jokerCall===q.jokerCall));
  for(const s of [game,other]) applyAction(s,0,{type:'play',...common});
  const views=[game,other].map(s=>botObservation(s,1));
  assert.deepEqual(views[0],views[1]);
  assert.equal(views[0].friendKnown,false);
  const prior=replayRecurrentMemory(model,'win',[{observation:passView,action:{type:'pass'}}]);
  const groups=views.map(v=>recurrentGroup(v));
  assert.deepEqual(groups[0],groups[1]);
  assert.deepEqual(recurrentDistribution(model,groups[0],prior,'win'),recurrentDistribution(model,groups[1],prior,'win'));
});
