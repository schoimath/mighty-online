import {chooseModelAction, DEFAULT_MODEL} from './lab/agents.js';
import {rngFor} from './lab/game.js';

self.onmessage = ({data: {revision, seed, view, modelId = DEFAULT_MODEL}}) => {
  const rng = rngFor(seed ?? crypto.getRandomValues(new Uint32Array(1))[0]);
  self.postMessage({revision, modelId, action: chooseModelAction(modelId, view, rng)});
};
