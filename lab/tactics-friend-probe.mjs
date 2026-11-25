// A conditional drill, independent of the normal full-table match evaluation.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {botObservation, mighty, pointsIn, winningPlay} from '../engine.js';
import {createGame, applyAction} from '../table-deal.js';
import {rngFor} from './game.js';
import * as current from './table-agents.js';

const [baselinePath, count='1600', firstSeed='18510000'] = process.argv.slice(2);
if (!baselinePath || !Number.isSafeInteger(+count) || +count < 1 || !Number.isSafeInteger(+firstSeed)) {
  throw Error('Arguments: BASE_CHECKOUT [DEALS] [FIRST_SEED]');
}
const old = await import(pathToFileURL(resolve(baselinePath, 'lab/table-agents.js')));
const stats = Object.fromEntries(current.MODEL_CATALOG.map(m => [m.id, {before:0, after:0}]));
let eligible = 0;
for (let i=0; i<+count; i++) {
  const seed=+firstSeed+i, rng=rngFor(seed), trump=['H','S','C','D'][i%4], master=mighty(trump);
  const g=createGame({random:rng, firstSeat:i%5});
  const declarer=g.turn, history=Array.from({length:5},()=>[]);
  const observe = () => botObservation(g,g.turn);
  const act = action => {
    history[g.turn].push({observation:observe(),action});
    applyAction(g,g.turn,action,rng);
  };
  act({type:'bid',points:14,suit:trump});
  for(let j=0;j<4;j++) act({type:'pass'});
  if (!g.hands[declarer].includes(trump+'A') || g.hands[declarer].includes(master)) continue;
  const bury=g.hands[declarer].filter(c=>c[0]!==trump && !c.endsWith('A') && c!=='JK').slice(0,3);
  if (bury.length!==3) continue;
  act({type:'discard',cards:bury});
  act({type:'friend',kind:'card',card:master});
  const opener=observe().choices.plays.find(p=>p.card!=='JK' && p.card.endsWith('A'));
  if (!opener) continue;
  act({type:'play',...opener});
  while (g.trickNo===1) {
    const choices=observe().choices.plays;
    const ordinary=choices.find(p=>p.card!==master && p.card!=='JK' && p.card[0]!==trump);
    act({type:'play',...(ordinary??choices[0])});
  }
  if (g.turn!==declarer || !g.hands[g.friend]?.includes(master)) continue;
  act({type:'play',card:trump+'A'});
  while (g.trickNo===2 && g.turn!==g.friend) {
    const choices=observe().choices.plays;
    const ordinary=choices.find(p=>p.card!=='JK' && !pointsIn([p.card]));
    act({type:'play',...(ordinary??choices[0])});
  }
  if (g.turn!==g.friend || g.trickNo!==2 || winningPlay(g).seat!==declarer) continue;
  const v=observe();
  const ordinary=v.choices.plays.filter(p=>p.card!==master && p.card!=='JK');
  const exposed=pointsIn(v.trick.map(p=>p.card)) + Number(ordinary.every(p=>pointsIn([p.card])>0));
  if (!ordinary.length || v.trick.length===4 || exposed>=3 || v.hand.includes('JK') ||
      v.playedTricks.some(t=>t.cards.some(p=>p.card==='JK'))) continue;
  eligible++;
  for (const {id:modelId} of current.MODEL_CATALOG) {
    for (const [version,column] of [[old,'before'],[current,'after']]) {
      const memory = version.hasSeatMemory(modelId) ? version.memoryForReplacement(modelId,history[v.seat]) : null;
      const {action}=version.decideTableTurn({modelId,view:v,memory,seed});
      if (!v.choices.plays.some(p=>p.card===action.card)) throw Error('Illegal play in drill');
      stats[modelId][column] += Number(action.card===master);
    }
  }
}
console.log(JSON.stringify({deals:+count,firstSeed:+firstSeed,eligiblePerModel:eligible,mightyPlayed:stats},null,2));
