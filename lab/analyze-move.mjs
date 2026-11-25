import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {leadSuit,mighty} from '../engine.js';
import {worldSampler} from './belief.js';
import {legalActionsFromObservation} from './live-game.js';
import {assessMove,actionKey,beliefBaseline,heuristicContinuation} from './belief-policy.js';
import {decisionGroup,distribution} from './policy.js';
import {recurrentGroup,recurrentDistribution,replayRecurrentMemory,createRecurrentPolicy,recurrentSchema} from './recurrent.js';

const digest = data=>createHash('sha256').update(data).digest('hex');
const implementationHash = () => {
  const hash=createHash('sha256');
  for(const name of ['./belief-policy.js','./belief.js','./live-game.js','./rules-agents.js','./partnership-policy.js',
    './recurrent.js','./policy.js','./game.js','../engine.js','../bot-weights.js','../bot-sampling.js',
    '../bot-exchange.js','../table-deal.js','../table-scoring.js']) {
    hash.update(name).update(readFileSync(new URL(name,import.meta.url)));
  }
  return hash.digest('hex');
};
async function loadCheckpoint(file,objective) {
  const raw=readFileSync(file);
  const exported=extname(file)==='.js' ? await import(pathToFileURL(resolve(file)).href) : JSON.parse(raw);
  const data=exported.recurrentModels??exported.default??exported.selected??exported;
  const model=data[objective]??data.weights??data;
  if(model.schema!==recurrentSchema && !model.context) throw Error('Expected a portable GRU or residual MLP checkpoint.');
  return {model,id:'sha256:'+digest(raw)};
}
function align(root,acts,probs) {
  const byAction=new Map(acts.map((a,i)=>[actionKey(a),probs[i]]));
  return legalActionsFromObservation(root).map(a=>byAction.get(actionKey(a)));
}
const suitNames={S:'스페이드',H:'하트',D:'다이아몬드',C:'클로버',N:'노기루다'};
const marks={S:'♠',H:'♥',D:'♦',C:'♣'};
const cardName=(card,master)=>card==='JK'?'조커':(card===master?'마이티 ':'')+marks[card[0]]+card.slice(1);
function describeAction(a,master) {
  if(a.kind==='first') return '초구 프렌드';
  if(a.kind==='none') return '노프렌드';
  if(a.kind==='card') return cardName(a.card,master)+' 프렌드';
  return cardName(a.card,master)+(a.jokerCall?' 조커콜':a.suit?' ('+suitNames[a.suit]+' 지정)':'');
}
function explain(v,result) {
  const master=mighty(v.bid.suit), lead=leadSuit(v.trick);
  let situation;
  if(v.phase==='friend') {
    const specials=v.hand.filter(c=>c===master||c==='JK').map(c=>cardName(c,master));
    situation=`${suitNames[v.bid.suit]} ${v.bid.points}점 공약의 프렌드 선언 차례입니다. `+
      (specials.length?`주공 손에는 ${specials.join(', ')}가 있습니다.`:`주공 손에는 마이티와 조커가 모두 없습니다.`);
  } else if(v.trick.length) {
    const opening=v.trick[0];
    situation=`${v.trickNo}번째 트릭의 첫 카드는 ${cardName(opening.card,master)}입니다. `+
      (opening.jokerCall?'선이 조커콜을 선언했습니다.':lead?`따라갈 무늬는 ${suitNames[lead]}입니다.`:'다음 카드로 무늬가 정해집니다.');
  } else {
    const last=v.playedTricks.at(-1);
    situation=`${v.trickNo}번째 트릭의 선입니다. `+
      (last?`직전 트릭은 ${last.winner+1}번 자리가 가져갔습니다.`:`공약은 ${suitNames[v.bid.suit]} ${v.bid.points}점입니다.`);
  }
  const selected=describeAction(result.selected,master), nominee=describeAction(result.nominee,master);
  const gap=result.confirmationGap, num=x=>(x>0?'+':'')+x.toFixed(5);
  let evidence;
  if(!result.sampler.selection.accepted || !gap.n) evidence='재현 가능한 배치가 부족해 판단을 보류합니다.';
  else if(actionKey(result.selected)===actionKey(result.nominee))
    evidence=`정책이 고른 수는 ${selected}입니다. 선택 표본에서도 같은 수가 가장 높아 두 선택의 추정 차이는 0입니다.`;
  else {
    const interval=gap.ci95?` (근사 95% 구간 ${gap.ci95.map(num).join(' ~ ')})`:'';
    evidence=`정책 수는 ${selected}, 선택 표본에서 가장 높았던 수는 ${nominee}입니다. `+
      `독립 배치 ${gap.n}개에서 ${nominee}의 평균 효용 차이는 ${num(gap.mean)}${interval}입니다. `+
      (result.decision==='판단 보류'?'확인 표본에서 우위가 충분히 뚜렷하지 않아 판단을 보류합니다.':'확인 구간도 이 선택을 지지합니다.');
  }
  return situation+' '+evidence;
}
export async function analyzeObservation(input,options={}) {
  const {checkpoint,objective='balanced',model=null,seed=377,continuationKind='heuristic'}=options;
  const obs=input.observation??input;
  const history=()=> {
    // The declarer's kitty and original discard are preserved. Therefore the
    // reconstructed root private decision sequence is invariant across these worlds.
    const world=worldSampler(obs,{seed,withHistory:true,model}).sample(1024);
    if(!world) throw Error('Could not reconstruct the root private observation history.');
    return world.histories[obs.seat];
  };
  let chosen=beliefBaseline(obs), probabilities=null,actorId=heuristicContinuation.id,rootValue=null;
  let continuation=heuristicContinuation;
  if(checkpoint) {
    const loaded=await loadCheckpoint(checkpoint,objective);
    const weights=loaded.model;
    actorId=loaded.id;
    const recurrent=weights.schema===recurrentSchema;
    const group=recurrent ? recurrentGroup(obs) : decisionGroup(obs);
    const output=recurrent ? recurrentDistribution(weights,group,replayRecurrentMemory(weights,objective,history()),objective)
      : distribution(weights,group);
    chosen=group.choices[output.probs.indexOf(Math.max(...output.probs))]; rootValue=output.value;
    probabilities=align(obs,group.choices,output.probs);
    if(continuationKind==='checkpoint') {
      if(recurrent) {
        continuation={id:loaded.id+'/'+objective+'/greedy-five-seats',needsHistory:true,
          prepare:histories=>{
            const memories=histories.map(h=>replayRecurrentMemory(weights,objective,h));
            return seat=>{
              const actor=createRecurrentPolicy(weights,objective);
              actor.restoreMemory(memories[seat]);
              return actor;
            };
          },
          // The residual actor's hidden update for a play depends on this
          // turn's observation. Its actual selected card becomes public next turn.
          commitRoot:(actor,view)=>actor(view)};
      } else {
        continuation={id:loaded.id+'/greedy-five-seats',prepare:()=>()=>view=>{
          const g=decisionGroup(view), f=distribution(weights,g);
          return g.choices[f.probs.indexOf(Math.max(...f.probs))];
        }};
      }
    }
  } else if(continuationKind==='checkpoint') throw Error('Checkpoint continuation requires --checkpoint.');
  if(!['heuristic','checkpoint'].includes(continuationKind)) throw Error('Unknown continuation.');
  const result=assessMove(obs,{...options,chosen,probabilities,continuation});
  return {...result,actor:actorId,actorValue:rootValue,policyImplementationHash:implementationHash(),
    beliefWeightsHash:model?digest(JSON.stringify(model)):null,
    visibleContext:{seat:obs.seat,trick:obs.trickNo,leadSuit:leadSuit(obs.trick)??null,contract:obs.bid,
      ownRole:obs.selfRole,ownHand:obs.hand,publicTrick:obs.trick,mighty:mighty(obs.bid.suit)},
    explanation:explain(obs,result)};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const arg=(key,def)=>process.argv.includes('--'+key)?process.argv[process.argv.indexOf('--'+key)+1]:def;
  const input=JSON.parse(readFileSync(arg('input','examples/observation.json'),'utf8'));
  const file=arg('belief','lab/artifacts/belief/ownership.json');
  const result=await analyzeObservation(input,{model:file==='uniform'?null:JSON.parse(readFileSync(file,'utf8')),
    seed:Number(arg('seed',377)),objective:arg('objective','balanced'),checkpoint:arg('checkpoint',null),
    continuationKind:arg('continuation','heuristic'),selectN:Number(arg('selection',24)),confirmN:Number(arg('confirmation',32))});
  console.log(JSON.stringify(result,null,2));
}
