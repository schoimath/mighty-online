import test from 'node:test';
import assert from 'node:assert/strict';
import {botDecision, botObservation, DEFAULT_RULES, legalPlays, policyPlay} from '../engine.js';
import {createGame, applyAction} from '../table-deal.js';
import {conserveOpeningJoker} from '../table-tactics.js';
import {rngFor} from '../lab/game.js';
import {protectPartner} from '../lab/partnership-policy.js';
import {balancedTurn, replayBalancedMemory} from '../lab/table-memory.js';
import {decideTableTurn} from '../lab/table-agents.js';
import {clubPolicies} from './table-policy-models.mjs';

// Replay two deals from full games in which the cooperative policy opened or
// followed with the powerless Joker despite holding legal ordinary cards.
for (const [role, seed, firstSeat, suit, cards, lead] of [
  ['declarer', 671001, 1, 'D', ['S4','S2','H2'], null],
  ['opposition', 671005, 0, 'C', ['SQ','S10','DQ'], 'SK']
]) {
  test(`all table models keep the opening Joker with an ordinary alternative as ${role}`, () => {
    const random = rngFor(seed);
    const game = createGame({random, firstSeat});
    const history = [];
    const step = action => {
      if (game.turn === 3) history.push({observation:botObservation(game, 3), action});
      applyAction(game, game.turn, action, random);
    };
    step({type:'pass'}); step({type:'pass'}); step({type:'bid', points:14, suit});
    step({type:'pass'}); step({type:'pass'});
    step({type:'discard', cards});
    step({type:'friend', kind:'card', card:'SA'});
    if (lead) step({type:'play', card:lead});

    assert.equal(game.turn, 3);
    const view = botObservation(game, 3);
    const memory = replayBalancedMemory(history);
    assert.equal(view.selfRole, role);
    assert.equal(botDecision(protectPartner(view), policyPlay).card, 'JK');
    const before = structuredClone(view);
    for (const modelId of clubPolicies) {
      const choice = decideTableTurn({modelId, view, memory, seed});
      assert.notEqual(choice.action.card, 'JK');
      assert.doesNotThrow(() => applyAction(structuredClone(game), 3, choice.action));
      if (modelId === 'recurrent_balanced') {
        assert.deepEqual(choice.memory, balancedTurn(view, rngFor(seed), memory).memory);
      }
    }
    assert.deepEqual(view, before);
    assert.doesNotThrow(() => applyAction(game, 3, {type:'play',card:'JK'}));
  });
}

test('opening Joker policy respects forced plays, the Mighty and active Jokers', () => {
  const trumps = ['H2','H3','H4','H5','H6','H7','H8','H9','H10'];
  const viewFor = (hand, trick = [], trickNo = 1) => {
    const view = {phase:'play', bid:{suit:'H'}, rules:{...DEFAULT_RULES, allowFirstJokerCall:true}, trick, trickNo};
    return {...view, choices:{plays:legalPlays(view, hand)}};
  };
  const forcedLead = viewFor([...trumps, 'JK']);
  assert.deepEqual(forcedLead.choices.plays, [{card:'JK'}]);
  assert.equal(conserveOpeningJoker(forcedLead), forcedLead);
  const specialLead = viewFor([...trumps.slice(1), 'SA', 'JK']);
  assert.deepEqual(conserveOpeningJoker(specialLead).choices.plays, [{card:'SA'}]);
  const specialFollow = viewFor([...trumps.slice(1), 'SA', 'JK'], [{seat:0,card:'SQ'}]);
  assert.deepEqual(specialFollow.choices.plays, [{card:'SA'},{card:'JK'}]);
  assert.equal(conserveOpeningJoker(specialFollow), specialFollow);
  for (const specials of [['JK'], ['JK','SA']]) {
    const forcedCall = viewFor(['C2','C6',...specials], [{seat:0,card:'C3',jokerCall:true}]);
    assert.deepEqual(forcedCall.choices.plays.map(p => p.card), specials);
    assert.equal(conserveOpeningJoker(forcedCall), forcedCall);
  }
  const later = viewFor(['H4','S5','JK'], [], 2);
  assert.equal(conserveOpeningJoker(later), later);
});
