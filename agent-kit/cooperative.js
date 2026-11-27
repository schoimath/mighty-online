import {botDecision, policyPlay} from '../engine.js';
import {protectPartner} from '../lab/partnership-policy.js';
import {withTableStrategy} from '../lab/table-strategy.js?v=1.1.20261127193124';

export default {
  apiVersion:1,
  id:'heuristic',
  label:'협력형',
  description:'팀원이 이길 때 점수를 보태고 위험한 점수 카드를 관리합니다.',
  decide({observation}) {
    return withTableStrategy(observation, view => ({action:botDecision(protectPartner(view), policyPlay)})).action;
  }
};
