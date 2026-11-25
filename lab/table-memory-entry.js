// Build the table's single GRU using npm run build:table-memory.
import {createRecurrentPolicy, replayRecurrentMemory} from './recurrent.js';
import model from './artifacts/recurrent-aux/best-balanced.json' with {type:'json'};

export function replayBalancedMemory(history) {
  return replayRecurrentMemory(model, 'balanced', history);
}

export function balancedTurn(view, rng, memory) {
  const policy = createRecurrentPolicy(model, 'balanced');
  if (memory != null) policy.restoreMemory(memory);
  const action = policy(view, rng);
  return {action, memory:policy.getMemory()};
}
