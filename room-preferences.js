import {DEFAULT_RULES, validateRules} from './engine.js';
import {commonModelChoice, isModelId} from './lab/table-agents.js';
import {normalizeGameSpeed} from './table-timing.js';

const storageKey = 'mighty-room-preferences';

export function roomPreferences() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch {}
  let rules = DEFAULT_RULES;
  try { rules = validateRules(saved?.rules); } catch {}
  const roundLimit = saved?.roundLimit;
  const modelChoice = isModelId(saved?.modelChoice) || saved?.modelChoice === 'random'
    ? saved.modelChoice : commonModelChoice(saved?.models);
  return {roundLimit:roundLimit === null || roundLimit === 20 ? roundLimit : 10,
    pace:normalizeGameSpeed(saved?.pace), rules, modelChoice};
}

export function rememberRoom(change) {
  try { localStorage.setItem(storageKey, JSON.stringify({...roomPreferences(), ...change})); } catch {}
}
