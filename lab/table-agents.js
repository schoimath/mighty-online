import agents from '../agent-kit/registry.js?v=1.1.20261127190218';
import {checkAgent, runAgent} from '../agent-kit/protocol.js?v=1.1.20261127190218';
import {withTableStrategy} from './table-strategy.js?v=1.1.20261127190218';
import {rngFor} from './game.js';
import {contractSearchAction} from './contract-search.js';
import {replayBalancedMemory, balancedTurn} from './table-memory.js';

export const DEFAULT_MODEL = 'contract_search';
export const MODEL_CATALOG = [
  {id:DEFAULT_MODEL, label:'공약 탐색형', description:'주공이 바닥 세 장을 본 뒤 가능한 공약의 개인 정산을 모의 대국으로 비교합니다.'},
  {id:'recurrent_balanced', label:'기억형 · 균형', description:'앞선 수를 기억하고, 탐색이 도움이 된다고 학습한 차례에는 여러 카드를 냈을 때의 결과를 비교합니다.'},
];
const registered = new Map();
for (const agent of agents) {
  const {id, label, description} = checkAgent(agent);
  if (MODEL_CATALOG.some(model => model.id === id)) throw new Error('중복된 AI 모델 ID: ' + id);
  registered.set(id, agent);
  MODEL_CATALOG.push({id, label, description});
}
export const isModelId = id => MODEL_CATALOG.some(model => model.id === id);
export const hasSeatMemory = id => id === 'recurrent_balanced';

export function randomSeatModels(random = Math.random) {
  return Array.from({length:5}, () => MODEL_CATALOG[Math.floor(random() * MODEL_CATALOG.length)].id);
}

export function commonModelChoice(models) {
  const first = models?.[0];
  return Array.isArray(models) && models.length === 5 && isModelId(first) &&
    Array.from(models).every(id => id === first) ? first : 'random';
}

export function modelsForChoice(choice) {
  if (choice === 'random') return randomSeatModels();
  if (!isModelId(choice)) throw new Error('전체 AI 모델을 확인해 주세요.');
  return Array(5).fill(choice);
}

export function memoryForReplacement(id, seatHistory) {
  return hasSeatMemory(id) ? replayBalancedMemory(seatHistory) : null;
}

function chooseModelTurn(modelId, view, rng, memory, recurrentTurn) {
  switch (modelId) {
    case 'contract_search': return {action:contractSearchAction(view, rng)};
    case 'recurrent_balanced': return recurrentTurn(view, rng, memory);
    default: throw new Error('지원하지 않는 AI 모델입니다.');
  }
}

// The host commits a worker's proposed memory only after accepting the move.
export function decideTableTurn({modelId = DEFAULT_MODEL, view, seed, memory}, recurrentTurn = balancedTurn) {
  const turnSeed = seed ?? crypto.getRandomValues(new Uint32Array(1))[0];
  const agent = registered.get(modelId);
  if (agent) {
    try {
      return {action:runAgent(agent, view, turnSeed)};
    } catch (error) {
      if (modelId === 'heuristic') throw error;
      console.warn('AI 선택 실패, 협력형이 이번 수를 대신합니다.', modelId);
      return {action:runAgent(registered.get('heuristic'), view, turnSeed)};
    }
  }
  return withTableStrategy(view, table => chooseModelTurn(modelId, table, rngFor(turnSeed), memory, recurrentTurn));
}
