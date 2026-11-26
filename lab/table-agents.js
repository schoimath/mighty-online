import {botDecision, policyPlay} from '../engine.js';
import {withJokerStatus} from '../table-joker.js';
import {conserveMightyOnTrumpAce, conserveOpeningJoker, protectCalledJoker} from '../table-tactics.js?v=1.1.20261126122116';
import {preferTrumpLead} from '../table-trump-lead.js';
import {preferSideAcePlan} from '../table-side-ace.js?v=1.1.20261126122116';
import {coordinateFriendPlay} from '../table-friend-play.js?v=1.1.20261126122116';
import {rngFor} from './game.js';
import {protectPartner} from './partnership-policy.js';
import {contractSearchAction} from './contract-search.js';
import {replayBalancedMemory, balancedTurn} from './table-memory.js';

export const DEFAULT_MODEL = 'contract_search';
export const MODEL_CATALOG = [
  {id:DEFAULT_MODEL, label:'공약 탐색형', description:'주공이 바닥 세 장을 본 뒤 가능한 공약의 개인 정산을 모의 대국으로 비교합니다.'},
  {id:'recurrent_balanced', label:'기억형 · 균형', description:'앞선 수를 기억하고, 탐색이 도움이 된다고 학습한 차례에는 여러 카드를 냈을 때의 결과를 비교합니다.'},
  {id:'heuristic', label:'협력형', description:'팀원이 이길 때 점수를 보태고 위험한 점수 카드를 관리합니다.'}
];
export const isModelId = id => MODEL_CATALOG.some(model => model.id === id);
export const hasSeatMemory = id => id === 'recurrent_balanced';

export function randomSeatModels(random = Math.random) {
  return Array.from({length:5}, () => MODEL_CATALOG[Math.floor(random() * MODEL_CATALOG.length)].id);
}

export function memoryForReplacement(id, seatHistory) {
  return hasSeatMemory(id) ? replayBalancedMemory(seatHistory) : null;
}

function chooseModelTurn(modelId, view, rng, memory, recurrentTurn) {
  switch (modelId) {
    case 'contract_search': return {action:contractSearchAction(view, rng)};
    case 'recurrent_balanced': return recurrentTurn(view, rng, memory);
    case 'heuristic': return {action:botDecision(protectPartner(view), policyPlay)};
    default: throw new Error('지원하지 않는 AI 모델입니다.');
  }
}

// The host commits a worker's proposed memory only after accepting the move.
export function decideTableTurn({modelId = DEFAULT_MODEL, view, seed, memory}, recurrentTurn = balancedTurn) {
  const rng = rngFor(seed ?? crypto.getRandomValues(new Uint32Array(1))[0]);
  const openingView = conserveOpeningJoker(withJokerStatus(view));
  const tableView = protectCalledJoker(conserveMightyOnTrumpAce(openingView));
  const decision = chooseModelTurn(modelId, tableView, rng, memory, recurrentTurn);
  if (tableView.selfRole === 'declarer') {
    decision.action = preferSideAcePlan(tableView, preferTrumpLead(tableView, decision.action));
  } else if (tableView.selfRole === 'friend') {
    decision.action = coordinateFriendPlay(tableView, decision.action);
  }
  return decision;
}
