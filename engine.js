// The room host owns the game state. Guests receive only their getView() projection.
import {playWeights} from './bot-weights.js';
import {selectDiscard} from './bot-exchange.js';
import {sampler} from './bot-sampling.js';
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const DECK = [...SUITS.flatMap(suit => RANKS.map(rank => suit + rank)), 'JK'];
const CONTRACTS = Array.from({ length: 8 }, (_, index) =>
  [...SUITS, 'N'].map(suit => ({ points: 13 + index, suit }))
).flat();
const SEATS = 5;
export const DEFAULT_RULES = Object.freeze({
  minBid: 14, allowFirstFriend: true, allowFirstJokerCall: false, allowLastJoker: false
});
const LEGACY_RULES = Object.freeze({...DEFAULT_RULES, minBid: 13});
const gameRules = state => state.rules ? {...DEFAULT_RULES, ...state.rules} : LEGACY_RULES;

export function validateRules(rules = {}, defaults = DEFAULT_RULES) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('게임 규칙을 확인해 주세요.');
  const {minBid = defaults.minBid, allowFirstFriend = defaults.allowFirstFriend,
    allowFirstJokerCall = defaults.allowFirstJokerCall, allowLastJoker = defaults.allowLastJoker ?? false} = rules;
  if (!Number.isInteger(minBid) || minBid < 13 || minBid > 20) throw new Error('최저 공약은 13~20점에서 선택해 주세요.');
  if ([allowFirstFriend, allowFirstJokerCall, allowLastJoker].some(value => typeof value !== 'boolean')) {
    throw new Error('프렌드와 조커 규칙의 허용 여부를 선택해 주세요.');
  }
  return {minBid, allowFirstFriend, allowFirstJokerCall, allowLastJoker};
}
const nextSeat = seat => (seat + 1) % SEATS;
const validSeat = seat => Number.isInteger(seat) && seat >= 0 && seat < SEATS;
export const mighty = trump => trump === 'S' ? 'DA' : 'SA';
const caller = trump => trump === 'C' ? 'S3' : 'C3';
const rank = card => card === 'JK' ? -1 : RANKS.indexOf(card.slice(1));
const point = card => Number(rank(card) >= RANKS.indexOf('10'));
const pointsIn = cards => cards.reduce((sum, card) => sum + point(card), 0);
const sameContract = (a, b) => Boolean(b && a.points === b.points && a.suit === b.suit);

function sortHand(cards) {
  return cards.sort((a, b) => {
    if (a === 'JK') return 1;
    if (b === 'JK') return -1;
    return SUITS.indexOf(a[0]) - SUITS.indexOf(b[0]) || rank(b) - rank(a);
  });
}

function shuffledDeck() {
  const cards = [...DECK];
  const sample = new Uint32Array(1);
  for (let remaining = cards.length; remaining > 1; remaining--) {
    const limit = 2 ** 32 - (2 ** 32 % remaining);
    do { globalThis.crypto.getRandomValues(sample); } while (sample[0] >= limit);
    const index = sample[0] % remaining;
    [cards[remaining - 1], cards[index]] = [cards[index], cards[remaining - 1]];
  }
  return cards;
}

export function createGame({ firstSeat = 0, rules = DEFAULT_RULES } = {}) {
  if (!validSeat(firstSeat)) throw new Error('첫 좌석이 올바르지 않습니다.');
  const roundRules = validateRules(rules);
  const deck = shuffledDeck();
  return {
    phase: 'bid', firstSeat, turn: firstSeat, dealNo: 1, rules: roundRules,
    hands: Array.from({ length: SEATS }, (_, s) => sortHand(deck.slice(10 * s, 10 * s + 10))),
    kitty: deck.slice(50), discarded: [], bid: null, bidHistory: [],
    passed: Array(SEATS).fill(false), declarer: null, call: null, friend: null, friendKnown: false,
    trick: [], trickNo: 1, lastTrick: null, playedTricks: [], scores: Array(SEATS).fill(0),
    captured: Array.from({ length: SEATS }, () => []), result: null
  };
}

function higherBid(bid, previous) {
  return !previous || bid.points > previous.points ||
    (bid.points === previous.points && bid.suit === 'N' && previous.suit !== 'N');
}

function advanceAuction(state) {
  if (state.passed.every(Boolean)) {
    const dealNo = state.dealNo + 1;
    Object.assign(state, createGame({ firstSeat: nextSeat(state.firstSeat), rules: gameRules(state) }), { dealNo });
    return;
  }
  if (state.bid && state.passed.filter(Boolean).length === SEATS - 1) {
    state.declarer = state.bid.seat;
    state.turn = state.declarer;
    state.phase = 'discard';
    state.hands[state.turn] = sortHand([...state.hands[state.turn], ...state.kitty]);
    state.kitty = [];
    return;
  }
  do { state.turn = nextSeat(state.turn); } while (state.passed[state.turn]);
}

function leadSuit(trick) {
  if (trick[0]?.card === 'JK') return trick[0].suit || trick[1]?.card[0];
  return trick[0]?.card[0];
}

function jokerActive(state, trick = state.trick) {
  return state.trickNo > 1 && (state.trickNo < 10 || gameRules(state).allowLastJoker) && !trick[0]?.jokerCall;
}

function strength(card, trump, trick, activeJoker) {
  if (card === mighty(trump)) return 100;
  if (card === 'JK') return activeJoker ? 90 : -1;
  if (card[0] === trump) return 50 + rank(card);
  if (card[0] === leadSuit(trick)) return 20 + rank(card);
  return 0;
}

function winningPlay(state, trick = state.trick) {
  const trump = state.bid.suit;
  const activeJoker = jokerActive(state, trick);
  return trick.reduce((best, play) =>
    strength(play.card, trump, trick, activeJoker) > strength(best.card, trump, trick, activeJoker) ? play : best
  );
}

function legalPlays(state, hand) {
  const trump = state.bid.suit;
  const { trick, trickNo } = state;
  let cards = hand;
  if (!trick.length) {
    if (trickNo === 1 && hand.some(card => card[0] !== trump)) {
      cards = hand.filter(card => card[0] !== trump);
    }
    return cards.flatMap(card => {
      if (card === 'JK' && jokerActive(state)) {
        return SUITS.map(suit => ({ card, suit }));
      }
      if (card === caller(trump) && (trickNo > 1 || gameRules(state).allowFirstJokerCall)) {
        return [{ card }, { card, jokerCall: true }];
      }
      return [{ card }];
    });
  }
  if (trick[0].jokerCall && hand.includes('JK')) {
    cards = hand.filter(card => card === 'JK' || card === mighty(trump));
  } else {
    const follow = leadSuit(trick);
    if (follow && hand.some(card => card[0] === follow)) {
      cards = hand.filter(card => card[0] === follow || card === mighty(trump) || card === 'JK');
    }
  }
  return cards.map(card => ({ card }));
}

function choicesFor(state, seat) {
  const choices = { canPass: false, bids: [], discard: false, contracts: [], friends: [], plays: [] };
  if (seat !== state.turn) return choices;
  switch (state.phase) {
    case 'bid':
      choices.canPass = true;
      choices.bids = CONTRACTS.filter(b => b.points >= gameRules(state).minBid && higherBid(b, state.bid));
      break;
    case 'discard':
      choices.discard = true;
      choices.contracts = CONTRACTS.filter(b =>
        b.points >= state.bid.points + (b.suit === state.bid.suit ? 0 : 2));
      break;
    case 'friend':
      choices.friends = [...DECK.map(card => ({ kind: 'card', card })), { kind: 'none' }];
      if (gameRules(state).allowFirstFriend) choices.friends.unshift({ kind: 'first' });
      break;
    case 'play':
      choices.plays = legalPlays(state, state.hands[seat]);
      break;
  }
  return choices;
}

function selfRole(state, seat) {
  if (seat === state.declarer) return 'declarer';
  if (!state.call || (state.call.kind === 'first' && !state.friendKnown)) return 'unknown';
  return seat === state.friend ? 'friend' : 'opposition';
}

export function getView(state, seat) {
  if (!validSeat(seat)) throw new Error('참가 좌석이 올바르지 않습니다.');
  const { phase, turn, dealNo, passed, bid, bidHistory, declarer, friendKnown, call,
    trick, trickNo, lastTrick, scores, captured, result } = state;
  const friend = friendKnown ? state.friend : null;
  const covered = player => player === declarer || player === friend;
  let recentTrick = lastTrick;
  if (lastTrick && covered(lastTrick.winner)) {
    recentTrick = {number: lastTrick.number, winner: lastTrick.winner, cards: [], points: null};
    // The fifth play is public on the felt before the trick is swept into its pile.
    if (!trick.length) recentTrick.finalPlay = lastTrick.cards.at(-1);
  }
  const visible = {
    seat, phase, turn, dealNo, rules: gameRules(state), hand: state.hands[seat], counts: state.hands.map(h => h.length),
    passed, bid, bidHistory, declarer, friendKnown, friend,
    call, selfRole: selfRole(state, seat), trick, trickNo, lastTrick: recentTrick, result,
    scores: scores.map((score, player) => covered(player) ? null : score),
    captured: captured?.map((cards, player) => covered(player) ? [] : cards),
    discarded: seat === declarer ? state.discarded : [],
    choices: choicesFor(state, seat)
  };
  return structuredClone(visible);
}

function finishTrick(state) {
  const winner = winningPlay(state).seat;
  const scoringCards = state.trick.map(play => play.card).filter(point);
  const points = scoringCards.length;
  state.captured[winner].push(...scoringCards);
  state.scores[winner] += points;
  state.lastTrick = { cards: state.trick, winner, points, number: state.trickNo };
  state.playedTricks?.push(state.lastTrick);
  state.trick = [];
  if (state.call.kind === 'first' && state.trickNo === 1) {
    state.friend = winner === state.declarer ? null : winner;
    state.friendKnown = true;
  }
  if (state.trickNo < 10) {
    state.turn = winner;
    state.trickNo++;
    return;
  }
  state.phase = 'result';
  state.turn = null;
  state.friendKnown = true;
  state.scores[state.declarer] += pointsIn(state.discarded);
  const attack = state.scores[state.declarer] + (state.friend === null ? 0 : state.scores[state.friend]);
  state.result = {
    won: attack >= state.bid.points, points: attack, target: state.bid.points,
    declarer: state.declarer, friend: state.friend
  };
}

function placeCard(state, seat, play) {
  state.hands[seat] = state.hands[seat].filter(card => card !== play.card);
  state.trick.push({ seat, ...play });
  if (state.call.kind === 'card' && play.card === state.call.card) state.friendKnown = true;
  if (state.trick.length === SEATS) finishTrick(state);
  else state.turn = nextSeat(seat);
}

export function applyAction(state, seat, action) {
  if (!validSeat(seat) || seat !== state.turn) throw new Error('지금은 내 차례가 아닙니다.');
  if (!action || typeof action !== 'object') throw new Error('행동을 선택해 주세요.');
  const choices = choicesFor(state, seat);
  if (state.phase === 'bid' && (action.type === 'bid' || action.type === 'pass')) {
    if (action.type === 'pass') {
      state.passed[seat] = true;
      state.bidHistory.push({ seat, pass: true });
    } else {
      const bid = choices.bids.find(b => sameContract(b, action));
      if (!bid) throw new Error('부를 수 있는 공약을 선택해 주세요.');
      state.bid = { seat, ...bid };
      state.bidHistory.push({ ...state.bid });
    }
    advanceAuction(state);
  } else if (choices.discard && action.type === 'discard') {
    const { cards, contract = state.bid } = action;
    if (!Array.isArray(cards) || cards.length !== 3 || new Set(cards).size !== 3 ||
      !cards.every(card => state.hands[seat].includes(card))) {
      throw new Error('내 손에서 서로 다른 카드 세 장을 골라 주세요.');
    }
    if (!choices.contracts.some(b => sameContract(b, contract))) {
      throw new Error('기루다를 바꾸려면 공약을 두 점 이상 올려 주세요.');
    }
    state.bid = { seat, points: contract.points, suit: contract.suit };
    state.discarded = [...cards];
    state.hands[seat] = state.hands[seat].filter(card => !cards.includes(card));
    state.phase = 'friend';
  } else if (state.phase === 'friend' && action.type === 'friend') {
    const call = choices.friends.find(f => f.kind === action.kind && f.card === action.card);
    if (!call) throw new Error('프렌드 조건을 선택해 주세요.');
    state.call = call;
    if (call.kind === 'card') {
      const holder = state.hands.findIndex(hand => hand.includes(call.card));
      state.friend = holder === -1 || holder === seat ? null : holder;
    }
    state.friendKnown = call.kind === 'none';
    state.phase = 'play';
  } else if (state.phase === 'play' && action.type === 'play') {
    const play = choices.plays.find(p => p.card === action.card && p.suit === action.suit &&
      (p.jokerCall ?? false) === (action.jokerCall ?? false));
    if (!play) throw new Error('이번 차례에 낼 수 있는 카드를 선택해 주세요.');
    placeCard(state,seat,play);
  } else {
    throw new Error('현재 단계에서 할 수 없는 행동입니다.');
  }
  return state;
}

function preferredSuit(hand) {
  const value = suit => hand.reduce((sum, card) =>
    sum + (card[0] === suit ? 1 + rank(card) / 16 : 0), 0);
  return [...SUITS].sort((a, b) => value(b) - value(a))[0];
}

function keepValue(card, trump) {
  if (card === mighty(trump)) return 100;
  if (card === 'JK') return 90;
  return rank(card) + (card[0] === trump ? 22 : 0);
}

export function baselinePlay(view) {
  const { hand, choices, bid, trick, trickNo, seat } = view;
  const trump = bid.suit;
  const options = choices.plays;
  if (!trick.length) {
    const favoredSuit = preferredSuit(hand);
    const leadValue = p => {
      if (p.card === 'JK') {
        if (!jokerActive(view)) return -100;
        return (trickNo >= 8 ? 50 : 6) + Number(p.suit === favoredSuit);
      }
      if (p.card === mighty(trump)) return trickNo < 8 ? 1 : 30;
      if (p.jokerCall && !hand.includes('JK') && view.call?.card !== 'JK') return 18;
      return rank(p.card) + Number(p.card[0] === favoredSuit) + (p.card.endsWith('A') ? 3 : 0);
    };
    return options.reduce((best, p) => leadValue(p) > leadValue(best) ? p : best);
  }
  const bestSeat = winningPlay(view).seat;
  const isAlly = view.selfRole === 'friend' ? bestSeat === view.declarer :
    view.selfRole === 'declarer' ? bestSeat === view.friend :
    view.friendKnown && bestSeat !== view.declarer && bestSeat !== view.friend;
  const followValue = p => {
    const after = [...trick, { seat, ...p }];
    const takesTrick = winningPlay(view, after).seat === seat;
    const cost = keepValue(p.card, trump) / 10;
    if (p.card === 'JK' && !jokerActive(view)) return -2;
    if (isAlly) return (takesTrick ? -3 : 0) + point(p.card) * 6 - cost;
    const pointsAtStake = pointsIn(after.map(play => play.card));
    return (takesTrick ? 3 + pointsAtStake * 2 : -point(p.card) * 4) - cost;
  };
  return options.reduce((best, p) => followValue(p) > followValue(best) ? p : best);
}

function allyChance(view, seat) {
  if (seat === view.seat) return 1;
  if (view.selfRole === 'friend') return Number(seat === view.declarer);
  if (view.selfRole === 'declarer') return view.friendKnown ? Number(seat === view.friend) : 0.25;
  if (seat === view.declarer || seat === view.friend) return 0;
  return view.friendKnown ? 1 : 2 / 3;
}

function ratedPlays(view, weights) {
  const options = view.choices.plays;
  const {trick, trickNo, hand} = view;
  const trump = view.bid.suit, master = mighty(trump);
  const known = new Set([...hand, ...view.discarded, ...trick.map(p => p.card), ...(view.captured || []).flat()]);
  for (const previous of view.playedTricks || []) for (const play of previous.cards) known.add(play.card);
  for (const play of view.lastTrick?.cards || []) known.add(play.card);
  if (view.lastTrick?.finalPlay) known.add(view.lastTrick.finalPlay.card);
  const unseen = DECK.filter(card => !known.has(card));
  const handSize = 11 - trickNo;
  const holding = handSize / Math.max(unseen.length, handSize);
  const later = 4 - trick.length;
  const attack = view.selfRole === 'declarer' || view.selfRole === 'friend';
  const inTrick = pointsIn(trick.map(p => p.card));
  const suitsInHand = Object.fromEntries(SUITS.map(s => [s, hand.filter(c => c[0] === s).length]));

  function teamWinChance(move) {
    const after = [...trick, {seat: view.seat, ...move}];
    const winner = winningPlay(view, after);
    let chance = allyChance(view, winner.seat);
    if (!later || winner.card === master) return chance;
    const active = jokerActive(view, after), lead = leadSuit(after);
    const best = strength(winner.card, trump, after, active);
    let specials = 0, higherSuit = 0, higherTrump = 0, inSuit = 0;
    for (const card of unseen) {
      if (card[0] === lead) inSuit++;
      if (strength(card, trump, after, active) <= best) continue;
      if (card === master || card === 'JK') specials++;
      else if (card[0] === lead) higherSuit++;
      else if (card[0] === trump) higherTrump++;
    }
    // Trumping requires a void. Hidden cards are sampled only through their
    // aggregate counts; no opponent hand or undisclosed partnership is read.
    const voidChance = Math.pow(1 - inSuit / Math.max(1, unseen.length), handSize);
    const beaten = 1 - Math.pow(1 - holding, specials + higherSuit) *
      (1 - voidChance * (1 - Math.pow(1 - holding, higherTrump)));
    for (let offset = 1; offset <= later; offset++) {
      const ally = allyChance(view, (view.seat + offset) % SEATS);
      chance += (ally - chance) * beaten;
    }
    return chance;
  }

  const rated = [];
  for (const move of options) {
    const card = move.card, suit = card[0], honor = point(card);
    const chance = teamWinChance(move);
    const isTrump = suit === trump, isMighty = card === master, isJoker = card === 'JK';
    const reserve = Math.max(0, rank(card)) / 12;
    const length = suitsInHand[suit] || 0;
    const active = jokerActive(view);
    // The first two terms value the trick and its point cards. The others
    // price resources spent now and the tactical consequences of the lead.
    const features = [
      (chance - 0.5) * (1 + inTrick + honor + 0.30 * later),
      (chance - 0.5) * honor,
      -reserve * handSize / 10,
      -Number(isTrump) * handSize / 10,
      -Number(isMighty) * handSize / 10,
      -Number(isJoker && active) * Math.max(0, (view.rules.allowLastJoker ? 10 : 9) - trickNo) / 8,
      Number(!trick.length && isTrump) * (attack ? 1 : -1),
      Number(!trick.length && move.jokerCall && !hand.includes('JK') && view.call?.card !== 'JK'),
      Number(suit !== trump && length === 1 && !isMighty && !isJoker),
      move.suit ? suitsInHand[move.suit] / 5 : 0
    ];
    let value = 0;
    for (let i = 0; i < features.length; i++) value += features[i] * weights[i];
    rated.push({move, value});
  }
  return rated.sort((a,b) => b.value - a.value);
}

export function policyPlay(view, weights = playWeights) {
  return view.choices.plays.length === 1 ? view.choices.plays[0] : ratedPlays(view,weights)[0].move;
}

function simulateEnd(view, sample, move) {
  const round = {phase:'play', rules:view.rules, turn:view.seat, declarer:view.declarer, friend:sample.friend,
    friendKnown:view.friendKnown, call:view.call, bid:view.bid, trickNo:view.trickNo, trick:view.trick.slice(),
    scores:sample.scores.slice(), hands:sample.hands.slice(), discarded:sample.discarded,
    captured:Array.from({length:5},()=>[])};
  placeCard(round,round.turn,move);
  while (round.phase === 'play') {
    const seat = round.turn, hand = round.hands[seat];
    const plays = legalPlays(round,hand);
    const next = plays.length === 1 ? plays[0] : baselinePlay({
      seat, hand, bid:round.bid, trick:round.trick, trickNo:round.trickNo, rules:round.rules,
      call:round.call, declarer:round.declarer, friendKnown:round.friendKnown,
      friend:round.friendKnown ? round.friend : null, selfRole:selfRole(round,seat), choices:{plays}
    });
    placeCard(round,seat,next);
  }
  const attack = view.seat === round.declarer || view.seat === round.friend;
  return (attack ? round.result.points : 20 - round.result.points) + 3 * Number(attack === round.result.won);
}

export function searchPlay(view, weights = playWeights) {
  if (view.choices.plays.length === 1) return view.choices.plays[0];
  const ranked = ratedPlays(view, weights);
  const draw = sampler(view, view.playedTricks || [], DECK, mighty(view.bid.suit), sortHand);
  if (!draw) return ranked[0].move;
  const candidates = ranked.slice(0,5);
  const original = baselinePlay(view);
  if (!candidates.some(c => c.move === original)) candidates.push(ranked.find(c => c.move === original));
  for (const c of candidates) c.sum = 0;
  let samples = 0;
  for (let i = 0; i < 18; i++) {
    const sample = draw();
    if (!sample) continue;
    samples++;
    for (const c of candidates) c.sum += simulateEnd(view,sample,c.move);
  }
  return candidates.reduce((best,c) =>
    c.sum + 0.12*samples*c.value > best.sum + 0.12*samples*best.value ? c : best).move;
}

// All recorded tricks were once face-up on the felt. The memory is host-local
// and is never added to the player projection or sent with room updates.
export function botObservation(state,seat) {
  const view = getView(state,seat);
  view.playedTricks = structuredClone(state.playedTricks || []);
  return view;
}

export function baselineDiscard(hand, trump) {
  const priority = card => keepValue(card, trump) - 8 * point(card);
  return [...hand].sort((a, b) => priority(a) - priority(b)).slice(0, 3);
}

export function botDecision(view, playPolicy = searchPlay, discardPolicy = selectDiscard) {
  if (view.phase === 'bid') {
    const suit = preferredSuit(view.hand);
    const strong = view.hand.filter(card => card === mighty(suit) || card === 'JK' || rank(card) >= 11).length;
    const length = view.hand.filter(card => card[0] === suit).length;
    const ceiling = Math.min(20, 10 + strong + Math.max(0, length - 2));
    // After an all-pass redeal a strong opener can accept the room's floor.
    const openAtFloor = !view.bid && view.dealNo > 1 && ceiling >= 15;
    const bid = view.choices.bids.find(b => b.suit === suit && (b.points <= ceiling || openAtFloor));
    return bid ? { type: 'bid', ...bid } : { type: 'pass' };
  }
  if (view.phase === 'discard') {
    const cards = discardPolicy(view.hand, view.bid.suit, mighty(view.bid.suit));
    return { type: 'discard', cards };
  }
  if (view.phase === 'friend') {
    const candidates = [mighty(view.bid.suit), 'JK', view.bid.suit + 'A', ...SUITS.map(s => s + 'A')];
    if (!view.rules.allowFirstFriend) candidates.push(...SUITS.map(s => s + 'K'));
    const card = candidates.find(c => DECK.includes(c) && !view.hand.includes(c) && !view.discarded.includes(c));
    return card ? { type: 'friend', kind: 'card', card } :
      { type: 'friend', kind: view.rules.allowFirstFriend ? 'first' : 'none' };
  }
  if (view.phase === 'play') return { type: 'play', ...playPolicy(view) };
  throw new Error('이번 판이 끝났습니다.');
}

export function botAction(state, seat = state.turn) {
  if (!validSeat(seat) || seat !== state.turn) throw new Error('컴퓨터의 차례가 아닙니다.');
  return botDecision(botObservation(state, seat));
}
