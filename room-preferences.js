import {DEFAULT_RULES, validateRules} from './engine.js';
import {isModelId, randomSeatModels} from './lab/table-agents.js';

const storageKey = 'mighty-room-preferences';

export function roomPreferences() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch {}
  let rules = DEFAULT_RULES;
  try { rules = validateRules(saved?.rules); } catch {}
  const roundLimit = saved?.roundLimit;
  const models = Array.from({length:5}, (_, seat) => {
    const id = saved?.models?.[seat];
    return isModelId(id) ? id : null;
  });
  return {roundLimit:roundLimit === null || roundLimit === 20 ? roundLimit : 10, rules, models};
}

export function rememberRoom(change) {
  try { localStorage.setItem(storageKey, JSON.stringify({...roomPreferences(), ...change})); } catch {}
}

export function roomModels(overrides) {
  return randomSeatModels().map((randomModel, seat) => overrides[seat] ?? randomModel);
}
