import test from 'node:test';
import assert from 'node:assert/strict';
import {intermediatePlayView, nextTablePlay, rememberCompletedTricks, sweptTrickView} from '../table-playback.js';

const first = ['S6','SA','S3','JK','H7'].map((card,seat) => ({seat,card}));
const second = [{seat:1,card:'C3',jokerCall:true},{seat:2,card:'CA'},{seat:3,card:'C7'},{seat:4,card:'C8'},{seat:0,card:'C4'}];
const third = [{seat:2,card:'D7'},{seat:3,card:'D8'}];
const base = {phase:'play',seat:0,turn:1,dealNo:2,trickNo:1,trick:first.slice(0,1),
  counts:[9,10,10,10,10],hand:['C4','H3'],choices:{plays:[],canDeclareSetting:false},
  friendKnown:false,friend:null,call:{kind:'card',card:'JK'},lastTrick:null};
const batches = [{number:1,cards:first,winner:1},{number:2,cards:second,winner:2}];

test('a delayed receipt shows each card at its own seat across two collected tricks and restores the live decision once',() => {
  let shown = base;
  const latest = {...base,turn:0,trickNo:3,trick:third,friend:3,friendKnown:true,hand:['H3'],choices:{plays:[{card:'H3'}]},
    lastTrick:{number:2,winner:2,points:null,cards:[]}};
  const buffer = new Map();
  rememberCompletedTricks(buffer,latest,shown,batches);
  const sequence = [],winners = [];
  for (let step; (step = nextTablePlay(shown,latest,buffer));) {
    sequence.push(step.move);
    shown = step.live ? latest : intermediatePlayView(shown,latest,step);
    if (!step.live) { assert.equal(shown.turn,null); assert.deepEqual(shown.choices.plays,[]); }
    if (step.number === 1 && step.trick.length <= 3) assert.equal(shown.friendKnown,false);
    else assert.equal(shown.friend,3);
    if (step.winner !== undefined) { winners.push(step.winner); buffer.delete(step.number); }
    // Identical lobby redraws and overlapping replies must not replay a card.
    rememberCompletedTricks(buffer,latest,latest,batches);
  }
  assert.deepEqual(sequence,[...first.slice(1),...second,...third]);
  assert.deepEqual(winners,[1,2]);
  assert.equal(shown,latest);
  assert.deepEqual(shown.choices.plays,[{card:'H3'}]);
  assert.deepEqual(latest.lastTrick.cards,[]);
});

test('older servers can still display a covered final play with the four actual cards this viewer saw',() => {
  const shown = {...base,trick:first.slice(0,4)};
  const latest = {...shown,trick:[],trickNo:2,lastTrick:{number:1,winner:1,cards:[],points:null,finalPlay:first[4]}};
  const buffer = new Map();
  rememberCompletedTricks(buffer,latest,shown);
  assert.deepEqual(nextTablePlay(shown,latest,buffer).trick,first);
  const absent = new Map();
  rememberCompletedTricks(absent,latest,base);
  assert.equal(nextTablePlay(base,latest,absent),null);
});

test('a final trick finishes before the result; hand/seat changes and missing history cannot invent moves',() => {
  const shown = {...base,trickNo:10,trick:first.slice(0,3)};
  const latest = {...shown,phase:'result',trick:[],result:{},lastTrick:{number:10,winner:1,cards:[]}};
  const buffer = new Map([[10,{number:10,winner:1,cards:first}]]);
  const fourth = nextTablePlay(shown,latest,buffer);
  const fifth = nextTablePlay(intermediatePlayView(shown,latest,fourth),latest,buffer);
  assert.deepEqual(fifth.trick,first);
  assert.equal(nextTablePlay({...shown,trick:first},latest,buffer),null);
  for (const changed of [{dealNo:3},{seat:-1}]) assert.equal(nextTablePlay(shown,{...latest,...changed},buffer),null);
  assert.equal(nextTablePlay(shown,latest,new Map()),null);
});

test('a sweep updates the public pile once, excludes the joker from points and covers a revealed friend',() => {
  const view = {...base,trick:first,declarer:0,friend:3,scores:[null,0,0,null,0],captured:[[],[],[],[],[]]};
  const opposition = sweptTrickView(view,1);
  assert.deepEqual(opposition.captured[1],['SA']);
  assert.equal(opposition.scores[1],1);
  assert.equal(opposition.lastTrick.points,1);
  const covered = sweptTrickView(view,3);
  assert.deepEqual(covered.captured[3],[]);
  assert.deepEqual(covered.lastTrick.cards,[]);
  assert.equal(covered.scores[3],null);
  const buffer = new Map([[1,batches[0]]]);
  rememberCompletedTricks(buffer,opposition,base,batches,2);
  assert.deepEqual([...buffer.keys()],[2]);
});
