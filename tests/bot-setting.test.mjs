import test from 'node:test';
import assert from 'node:assert/strict';
import {botObservation, DECK, DEFAULT_RULES} from '../engine.js';
import {shouldDeclareSetting} from '../bot-setting.js';
import {HostSession} from '../session.js';
import {analyzeSetting} from '../table-claim.js';

function position(hands, trump = 'C', rules = DEFAULT_RULES) {
  const n = hands[0].length;
  const otherCards = DECK.filter(card => !hands.flat().includes(card));
  const discarded = otherCards.splice(0, 3);
  const playedTricks = [];
  while (otherCards.length) {
    playedTricks.push({cards:otherCards.splice(0, 5).map((card, seat) => ({seat, card}))});
  }
  return {phase:'play', turn:1, declarer:1, hands, bid:{seat:1, suit:trump, points:14}, rules,
    discarded, playedTricks, trick:[], trickNo:11 - n, friendKnown:true, friend:null,
    call:{kind:'none'}, scores:[0,0,0,0,0], captured:[[],[],[],[],[]]};
}

const drawTrumps = () => position([
  ['C9','C3','HJ'], ['CA','CK','HA'], ['SQ','S8','S7'], ['D10','D6','D5'], ['H10','H9','H6']
]);

test('the bot can draw opposing trumps before claiming side winners using only its own observation', () => {
  const round = drawTrumps();
  const view = botObservation(round, 1);
  assert.equal(shouldDeclareSetting(view), true);
  assert.equal(analyzeSetting(round).success, true);
  [round.hands[0], round.hands[3]] = [round.hands[3], round.hands[0]];
  assert.deepEqual(botObservation(round, 1), view);
  assert.equal(shouldDeclareSetting(botObservation(round, 0)), false);
});

test('the bot keeps playing if an unseen Mighty or an undrawn trump could win', () => {
  for (const threat of ['SA','C4']) {
    const round = position([['S3',threat], ['HA','HK'], ['H4','H5'], ['H7','H9'], ['D2','D3']]);
    assert.equal(shouldDeclareSetting(botObservation(round, 1)), false);
  }
});

test('the bot can claim with a forced Joker call but plays out a final Joker under both rules', () => {
  const round = position([['C2','JK'], ['C3','HK'], ['D8','S8'], ['D4','H4'], ['H6','S6']], 'N');
  assert.equal(shouldDeclareSetting(botObservation(round, 1)), true);
  assert.equal(analyzeSetting(round).success, true);
  for (const allowLastJoker of [false, true]) {
    const last = position([['S3'], ['JK'], ['D2'], ['H2'], ['C2']], 'N', {...DEFAULT_RULES, allowLastJoker});
    assert.equal(analyzeSetting(last).success, allowLastJoker);
    assert.equal(shouldDeclareSetting(botObservation(last, 1)), false);
  }
});

test('human and AI declarers finish the tenth trick with a card and ordinary settlement', () => {
  for (const guest of [true, false]) {
    const room = new HostSession('방장', undefined, Array(5).fill('heuristic'));
    if (guest) room.addGuest('guest', '주공');
    room.start();
    Object.assign(room.round, position([
      ['H2','D9'], ['HA','SA'], ['H3','DJ'], ['H4','DK'], ['H5','DQ']
    ], 'N'));
    const play = card => {
      const action = {type:'play', card};
      if (room.botTurn) room.runBot(action);
      else room.act(room.round.turn, room.revision, action);
    };
    assert.equal(room.view(1).game.choices.canDeclareSetting, true);
    for (const card of ['HA','H3','H4','H5','H2']) play(card);
    assert.equal(room.round.trickNo, 10);
    assert.equal(room.view(1).game.choices.canDeclareSetting, false);
    assert.deepEqual(room.view(1).game.choices.plays, [{card:'SA'}]);
    const revision = room.revision;
    if (guest) assert.throws(() => room.act(1, revision, {type:'claim'}), /1~9/);
    else assert.equal(room.tryBotClaim(), null);
    assert.equal(room.revision, revision);
    if (guest) play('SA');
    else room.runBot(undefined, 42);
    for (const card of ['DJ','DK','DQ','D9']) play(card);
    assert.equal(room.round.phase, 'result');
    assert.equal(room.round.lastTrick.winner, 1);
    assert.equal(room.round.result.setting, undefined);
    assert.equal(room.view(0).scoreboard.rounds, 1);
  }
});

test('each live AI declares publicly before verification; cancellation falls back to an ordinary bot turn', () => {
  for (const model of ['heuristic','recurrent_balanced','contract_search']) {
    const room = new HostSession('방장', undefined, Array(5).fill(model));
    room.start();
    Object.assign(room.round, drawTrumps());
    const waiting = room.tryBotClaim();
    assert.ok(waiting);
    assert.equal(room.view(0).game.claimPending, true);
    assert.equal(room.tryBotClaim(), null);
    assert.equal(room.abandonClaim(waiting), true);
    assert.equal(room.tryBotClaim(), null);
    room.runBot({type:'play', card:'CA'});
    assert.equal(room.round.trick[0].card, 'CA');

    Object.assign(room.round, drawTrumps());
    const job = room.tryBotClaim();
    const verdict = analyzeSetting(job);
    assert.equal(room.finishClaim(job, verdict), true);
    for (let seat = 0; seat < 5; seat++) {
      const {game, scoreboard} = room.view(seat);
      assert.equal(game.result.setting.success, true);
      assert.deepEqual(game.result.setting.line, verdict.line);
      assert.equal(scoreboard.rounds, 1);
    }
  }
});
