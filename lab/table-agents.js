import {chooseModelAction, DEFAULT_MODEL, MODEL_CATALOG as previousModels} from './agents.js';
import {rngFor} from './game.js';
import {createRecurrentPolicy, replayRecurrentMemory} from './recurrent.js';
import {recurrentModels} from './artifacts/recurrent-aux/selected.js';
import {contractSearchAction} from './contract-search.js';
import {createBeliefPolicy} from './belief-policy.js';
import {ownershipModel} from './artifacts/belief/ownership.js';

export {DEFAULT_MODEL};
const objectives = new Map([
  ['recurrent_win', 'win'], ['recurrent_score', 'score'], ['recurrent_balanced', 'balanced']
]);
export const MODEL_CATALOG = [
  previousModels[0],
  {id:'recurrent_win', label:'기억형 · 승률', description:'이전 차례의 판단을 기억하며 자기 팀의 승률을 높이도록 학습했습니다.'},
  {id:'recurrent_score', label:'기억형 · 정산점수', description:'공약과 배율을 반영한 개인 정산점수를 높이도록 학습했습니다.'},
  {id:'recurrent_balanced', label:'기억형 · 균형', description:'팀 승리에 70%, 정규화한 개인 정산점수에 30%의 가중치를 두고 학습했습니다.'},
  {id:'contract_search', label:'공약 탐색형', description:'주공이 바닥 세 장을 본 뒤 가능한 공약의 개인 정산을 모의 대국으로 비교합니다.'},
  {id:'belief_learned', label:'후반 추론형 · 학습', description:'아홉 번째 트릭에서 남은 패의 주인을 추정하고, 여러 배분에서 유리한 수를 찾습니다.'},
  {id:'belief_uniform', label:'후반 추론형 · 기본', description:'아홉 번째 트릭에서 공개된 카드와 남은 장수에 맞춰 패를 나눠 보고 다음 수를 고릅니다.'},
  ...previousModels.slice(1)
];
export const isModelId = id => MODEL_CATALOG.some(model => model.id === id);
export const hasSeatMemory = id => objectives.has(id);
export function memoryForReplacement(id, seatHistory) {
  const goal = objectives.get(id);
  return replayRecurrentMemory(recurrentModels[goal], goal, seatHistory);
}
const endgamePolicies = new Map([
  ['belief_learned', createBeliefPolicy({model:ownershipModel})],
  ['belief_uniform', createBeliefPolicy({})]
]);

// A worker proposes both values. Only the host commits memory after the move
// has succeeded, so retrying a stale or failed request cannot advance the GRU.
export function decideTableTurn({modelId = DEFAULT_MODEL, view, seed, memory}) {
  const rng = rngFor(seed ?? crypto.getRandomValues(new Uint32Array(1))[0]);
  if (modelId === 'contract_search') return {action:contractSearchAction(view, rng)};
  if (endgamePolicies.has(modelId)) return {action:endgamePolicies.get(modelId)(view, rng)};
  const objective = objectives.get(modelId);
  if (!objective) return {action:chooseModelAction(modelId, view, rng)};
  const policy = createRecurrentPolicy(recurrentModels[objective], objective);
  if (memory != null) policy.restoreMemory(memory);
  const action = policy(view, rng);
  return {action, memory:policy.getMemory()};
}
