import {neuralAction} from './policy.js';
import {ruleAction} from './rules-agents.js';

export const DEFAULT_MODEL = 'legacy';
export const MODEL_CATALOG = [
  {id:'legacy', label:'탐색형', description:'보이지 않는 패를 여러 번 나눠 보고 카드를 고릅니다.'},
  {id:'win', label:'승리형', description:'자기 팀이 공약 대결에서 이길 확률을 학습합니다.'},
  {id:'score', label:'정산점수형', description:'개인이 받는 판당 정산점수를 높이도록 학습합니다.'},
  {id:'balanced', label:'균형형', description:'팀 승리와 개인 정산점수를 함께 고려합니다.'},
  {id:'downside_averse', label:'손실회피형', description:'정산에서 크게 잃는 경우에 추가 비용을 둡니다.'},
  {id:'heuristic', label:'협력형', description:'팀원이 이길 때 점수를 보태고 위험한 점수 카드를 관리합니다.'},
  {id:'conservative', label:'신중형', description:'공약을 지킬 만한 패가 있을 때 입찰합니다.'},
  {id:'aggressive', label:'공격형', description:'긴 기루다와 높은 카드가 있으면 적극적으로 입찰합니다.'},
  {id:'random', label:'무작위형', description:'현재 규칙에서 허용된 행동을 무작위로 고릅니다.'}
];
const learned = new Set(['win','score','balanced','downside_averse']);
export const isModelId = id => MODEL_CATALOG.some(model => model.id === id);
export function chooseModelAction(id, observation, rng = Math.random) {
  return learned.has(id) ? neuralAction(id, observation, rng) : ruleAction(id, observation, rng);
}
