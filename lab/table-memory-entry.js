// Build the table's single GRU using npm run build:table-memory.
import {createRecurrentPolicy, replayRecurrentMemory} from './recurrent.js';
import {gatedPlay} from './search-gate.js';
import model from './artifacts/table-search-gate/balanced.json' with {type:'json'};

export function replayBalancedMemory(history) {
  return replayRecurrentMemory(model, 'balanced', history);
}

export function balancedTurn(view, rng, memory) {
  const policy = createRecurrentPolicy(model, 'balanced');
  if (memory != null) policy.restoreMemory(memory);
  const action = policy(view, rng);
  return {action:view.phase === 'play' ? gatedPlay(model.searchGate, view, action) : action,
    memory:policy.getMemory()};
}
