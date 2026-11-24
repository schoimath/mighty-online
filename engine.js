// The room host owns the game state. Guests receive only their getView() projection.
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const DECK = [...SUITS.flatMap(suit => RANKS.map(rank => suit + rank)), 'JK'];
const CONTRACTS = Array.from({ length: 8 }, (_, index) =>
  [...SUITS, 'N'].map(suit => ({ points: 13 + index, suit }))
).flat();
const SEATS = 5;
const nextSeat = seat => (seat + 1) % SEATS;
const validSeat = seat => Number.isInteger(seat) && seat >= 0 && seat < SEATS;
const mighty = trump => trump === 'S' ? 'DA' : 'SA';
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

export function createGame({ firstSeat = 0 } = {}) {
  if (!validSeat(firstSeat)) throw new Error('첫 좌석이 올바르지 않습니다.');
  const deck = shuffledDeck();
  return {
    phase: 'bid', firstSeat, turn: firstSeat, dealNo: 1,
    hands: Array.from({ length: SEATS }, (_, s) => sortHand(deck.slice(10 * s, 10 * s + 10))),
    kitty: deck.slice(50), discarded: [], bid: null, bidHistory: [],
    passed: Array(SEATS).fill(false), declarer: null, call: null, friend: null, friendKnown: false,
    trick: [], trickNo: 1, lastTrick: null, scores: Array(SEATS).fill(0),
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
    Object.assign(state, createGame({ firstSeat: nextSeat(state.firstSeat) }), { dealNo });
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

function jokerActive(trickNo, trick) {
  return trickNo > 1 && trickNo < 10 && !trick[0]?.jokerCall;
}

function strength(card, trump, trick, trickNo) {
  if (card === mighty(trump)) return 100;
  if (card === 'JK') return jokerActive(trickNo, trick) ? 90 : -1;
  if (card[0] === trump) return 50 + rank(card);
  if (card[0] === leadSuit(trick)) return 20 + rank(card);
  return 0;
}

function winningPlay(trick, trump, number) {
  return trick.reduce((best, play) =>
    strength(play.card, trump, trick, number) > strength(best.card, trump, trick, number) ? play : best
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
      if (card === 'JK' && jokerActive(trickNo, trick)) {
        return SUITS.map(suit => ({ card, suit }));
      }
      if (card === caller(trump) && trickNo > 1) return [{ card }, { card, jokerCall: true }];
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
      choices.bids = CONTRACTS.filter(b => higherBid(b, state.bid));
      break;
    case 'discard':
      choices.discard = true;
      choices.contracts = CONTRACTS.filter(b =>
        b.points >= state.bid.points + (b.suit === state.bid.suit ? 0 : 2));
      break;
    case 'friend':
      choices.friends = [{ kind: 'first' }, { kind: 'none' }, ...DECK.map(card => ({ kind: 'card', card }))];
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
  const visible = {
    seat, phase, turn, dealNo, hand: state.hands[seat], counts: state.hands.map(h => h.length),
    passed, bid, bidHistory, declarer, friendKnown, friend: friendKnown ? state.friend : null,
    call, selfRole: selfRole(state, seat), trick, trickNo, lastTrick, scores, captured, result,
    discarded: seat === declarer || phase === 'result' ? state.discarded : [],
    choices: choicesFor(state, seat)
  };
  return structuredClone(visible);
}

function finishTrick(state) {
  const winner = winningPlay(state.trick, state.bid.suit, state.trickNo).seat;
  const scoringCards = state.trick.map(play => play.card).filter(point);
  const points = scoringCards.length;
  state.captured[winner].push(...scoringCards);
  state.scores[winner] += points;
  state.lastTrick = { cards: state.trick, winner, points, number: state.trickNo };
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
    state.hands[seat] = state.hands[seat].filter(card => card !== play.card);
    state.trick.push({ seat, ...play });
    if (state.call.kind === 'card' && play.card === state.call.card) state.friendKnown = true;
    if (state.trick.length === SEATS) finishTrick(state);
    else state.turn = nextSeat(seat);
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

function botPlay(view) {
  const { hand, choices, bid, trick, trickNo, seat } = view;
  const trump = bid.suit;
  const options = choices.plays;
  if (!trick.length) {
    const favoredSuit = preferredSuit(hand);
    const leadValue = p => {
      if (p.card === 'JK') {
        if (!jokerActive(trickNo, trick)) return -100;
        return (trickNo >= 8 ? 50 : 6) + Number(p.suit === favoredSuit);
      }
      if (p.card === mighty(trump)) return trickNo < 8 ? 1 : 30;
      if (p.jokerCall && !hand.includes('JK') && view.call?.card !== 'JK') return 18;
      return rank(p.card) + Number(p.card[0] === favoredSuit) + (p.card.endsWith('A') ? 3 : 0);
    };
    return options.reduce((best, p) => leadValue(p) > leadValue(best) ? p : best);
  }
  const bestSeat = winningPlay(trick, trump, trickNo).seat;
  const isAlly = view.selfRole === 'friend' ? bestSeat === view.declarer :
    view.selfRole === 'declarer' ? bestSeat === view.friend :
    view.friendKnown && bestSeat !== view.declarer && bestSeat !== view.friend;
  const followValue = p => {
    const after = [...trick, { seat, ...p }];
    const takesTrick = winningPlay(after, trump, trickNo).seat === seat;
    const cost = keepValue(p.card, trump) / 10;
    if (p.card === 'JK' && !jokerActive(trickNo, trick)) return -2;
    if (isAlly) return (takesTrick ? -3 : 0) + point(p.card) * 6 - cost;
    const pointsAtStake = pointsIn(after.map(play => play.card));
    return (takesTrick ? 3 + pointsAtStake * 2 : -point(p.card) * 4) - cost;
  };
  return options.reduce((best, p) => followValue(p) > followValue(best) ? p : best);
}

export function botAction(state, seat = state.turn) {
  if (!validSeat(seat) || seat !== state.turn) throw new Error('컴퓨터의 차례가 아닙니다.');
  const view = getView(state, seat);
  if (view.phase === 'bid') {
    const suit = preferredSuit(view.hand);
    const strong = view.hand.filter(card => card === mighty(suit) || card === 'JK' || rank(card) >= 11).length;
    const length = view.hand.filter(card => card[0] === suit).length;
    const ceiling = Math.min(19, 10 + strong + Math.max(0, length - 2));
    const bid = view.choices.bids.find(b => b.suit === suit && b.points <= ceiling);
    return bid ? { type: 'bid', ...bid } : { type: 'pass' };
  }
  if (view.phase === 'discard') {
    // Discarding an honor banks its point for the declarer.
    const priority = card => keepValue(card, view.bid.suit) - 8 * point(card);
    const cards = [...view.hand].sort((a, b) => priority(a) - priority(b)).slice(0, 3);
    return { type: 'discard', cards };
  }
  if (view.phase === 'friend') {
    const candidates = [mighty(view.bid.suit), 'JK', view.bid.suit + 'A', ...SUITS.map(s => s + 'A')];
    const card = candidates.find(c => DECK.includes(c) && !view.hand.includes(c) && !view.discarded.includes(c));
    return card ? { type: 'friend', kind: 'card', card } : { type: 'friend', kind: 'first' };
  }
  if (view.phase === 'play') return { type: 'play', ...botPlay(view) };
  throw new Error('이번 판이 끝났습니다.');
}
