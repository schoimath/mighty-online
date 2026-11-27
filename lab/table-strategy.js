import {withJokerStatus} from '../table-joker.js';
import {conserveMightyOnTrumpAce, conserveOpeningJoker, protectCalledJoker} from '../table-tactics.js?v=1.1.20261127190218';
import {preferTrumpLead} from '../table-trump-lead.js';
import {preferSideAcePlan} from '../table-side-ace.js?v=1.1.20261127190218';
import {coordinateFriendPlay} from '../table-friend-play.js?v=1.1.20261127190218';

export function withTableStrategy(view, choose) {
  const opening = conserveOpeningJoker(withJokerStatus(view));
  const table = protectCalledJoker(conserveMightyOnTrumpAce(opening));
  const decision = choose(table);
  if (table.selfRole === 'declarer') {
    decision.action = preferSideAcePlan(table, preferTrumpLead(table, decision.action));
  } else if (table.selfRole === 'friend') {
    decision.action = coordinateFriendPlay(table, decision.action);
  }
  return decision;
}
