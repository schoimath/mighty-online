import {createRecurrentPolicy} from './recurrent.js';
import {gatedPlay} from './search-gate.js';
import {chooseEndgame, isEndgameChoice} from './endgame-policy.js';

export function createGatedRecurrentPolicy(model, objective, options) {
  const base=createRecurrentPolicy(model,objective,options);
  if((!model.searchGate && !model.endgame) || options?.sample) return base;
  const policy=(view,rng)=>{
    const action=base(view,rng);
    if(view.phase!=='play') return action;
    if(model.endgame && isEndgameChoice(view)) return chooseEndgame(view,action,model.endgame);
    return model.searchGate ? gatedPlay(model.searchGate,view,action) : action;
  };
  policy.getMemory=base.getMemory;
  policy.restoreMemory=base.restoreMemory;
  return policy;
}
