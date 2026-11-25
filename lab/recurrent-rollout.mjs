import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {rngFor} from './game.js';
import {liveUtility, playLiveEpisode} from './live-game.js';
import {ruleAction} from './rules-agents.js';
import {neuralAction} from './policy.js';
import {createRecurrentPolicy, recurrentGroup, objectives, recurrentSchema, inputSize, actionSize} from './recurrent.js';

const read = file => JSON.parse(readFileSync(file,'utf8'));
const [mode,requestPath,outPath]=process.argv.slice(2);
if (mode==='schema') {
  console.log(JSON.stringify({inputSize,actionSize,recurrentSchema}));
} else if(mode==='teachers') {
  const sequences=readFileSync(requestPath,'utf8').trim().split(/\r?\n/).filter(Boolean).map(line=>{
    const t=JSON.parse(line);
    if(Array.isArray(t)) return t;
    const rows=[];
    const append=(view,contract)=> {
      const {state,features,priors,choices}=recurrentGroup(view,contract);
      rows.push({state,features,priors,objective:t.objective,dealNo:view.dealNo});
      return choices;
    };
    for(const entry of t.history) {
      const v=entry.observation??entry;
      append(v);
      if(v.phase==='discard') append(v,entry.action?.contract??v.bid);
    }
    const choices=append(t.observation);
    const samePlay=(a,b)=>a.card===b.card && (a.suit??null)===(b.suit??null) && !!a.jokerCall===!!b.jokerCall;
    if(t.observation.phase!=='play' || t.actions.length!==choices.length) throw Error('Incomplete teacher action coverage');
    rows.at(-1).teacherQ=choices.map(c=>{
      const i=t.actions.findIndex(a=>samePlay(c,a));
      if(i<0 || !Number.isFinite(t.teacherQ[i])) throw Error('Teacher/legal actions mismatch');
      return t.teacherQ[i];
    });
    rows.at(-1).confidence=t.weight;
    return rows;
  });
  writeFileSync(outPath,JSON.stringify(sequences));
} else {
  const req=read(requestPath), current=read(req.model), cfg=req.config;
  const archive=(req.archive??[]).map(path=>{
    const model=read(path);
    const id=createHash('sha256').update(JSON.stringify(model)).digest('hex').slice(0,12);
    return {model,id};
  });
  const makeRule=id=>(v,r)=>ruleAction(id,v,r);
  const sample=(items,rng)=>items[Math.floor(rng()*items.length)];
  const episodes=[];
  for(const spec of req.specs) {
    const {seed,seat,objective}=spec;
    const rng=rngFor(seed^0x66b8a5eb), rows=[], lineup=[];
    const policies=Array.from({length:5},(_,i)=>{
      if(i===seat) {
        lineup.push('learner/'+objective);
        return createRecurrentPolicy(current,objective,{sample:mode==='collect',record:mode==='collect'?row=>rows.push(row):null});
      }
      if(mode==='validate') {
        const id=cfg.validationBackground[(seed+i)%cfg.validationBackground.length];
        lineup.push(id);
        return id.startsWith('mlp/') ? (v,r)=>neuralAction(id.slice(4),v,r):makeRule(id);
      }
      const weights=[cfg.league.baseline,cfg.league.recent,archive.length?cfg.league.history:0];
      const draw=rng()*weights.reduce((a,b)=>a+b,0);
      if(draw<weights[0]) {
        const id=sample(cfg.league.rules,rng);
        lineup.push(id);
        return makeRule(id);
      }
      const old=draw>=weights[0]+weights[1] ? sample(archive,rng) : null;
      const goal=sample(objectives,rng);
      lineup.push((old?'history/'+old.id:'recent')+'/'+goal);
      return createRecurrentPolicy(old?.model??current,goal,{sample:true});
    });
    const result=playLiveEpisode({seed, firstSeat:seed%5, policies, rules:cfg.rules});
    const outcome=result.outcomes[seat];
    episodes.push({seed,seat,objective,lineup,...outcome,reward:liveUtility(outcome,objective,cfg),
      redeals:result.redealCount,...(mode==='collect'?{rows}:{})});
  }
  writeFileSync(outPath,JSON.stringify(episodes));
}
