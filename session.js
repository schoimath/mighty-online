import {applyAction, botAction, createGame, DEFAULT_RULES, getView, validateRules} from './engine.js';

const BOT_NAMES = ['솔', '달', '별', '구름', '바다'];
const validSeat = seat => Number.isInteger(seat) && seat >= 0 && seat < BOT_NAMES.length;

export class HostSession {
  #swaps = [];

  constructor(hostName, rules = DEFAULT_RULES) {
    this.players = [{name: hostName, bot: false}, null, null, null, null];
    this.hostSeat = 0;
    this.rules = validateRules(rules);
    this.connections = new Map();
    this.revision = 0;
    this.roundNumber = 0;
    this.round = null;
  }

  seatFor(id) {
    return this.connections.get(id) ?? -1;
  }

  addGuest(id, name) {
    if (this.round) return '진행 중인 게임입니다. 다음 판에 참가해 주세요.';
    if (id == null) return '참가자 연결을 확인해 주세요.';
    if (this.connections.has(id)) return '이미 입장한 연결입니다.';
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 16) return '닉네임은 1~16자로 입력해 주세요.';
    const seat = this.players.indexOf(null);
    if (seat < 0) return '다섯 자리가 모두 찼습니다.';
    this.connections.set(id, seat);
    this.players[seat] = {name: name.trim(), bot: false};
    this.revision++;
    return null;
  }

  removeGuest(id) {
    const seat = this.seatFor(id);
    if (seat < 0) return;
    this.connections.delete(id);
    this.#clearSwapsAt(seat);
    this.players[seat] = this.round ? this.botPlayer(seat) : null;
    this.revision++;
  }

  #lobbySeat(connectionId, revision) {
    if (this.round) throw new Error('자리는 대기실에서만 바꿀 수 있습니다.');
    const currentSeat = connectionId === null ? this.hostSeat : this.seatFor(connectionId);
    if (currentSeat < 0) throw new Error('참가자 연결을 확인해 주세요.');
    if (revision !== this.revision) throw new Error('대기실 상태가 바뀌었습니다. 다시 선택해 주세요.');
    return currentSeat;
  }

  #swapAt(seat) {
    return this.#swaps.find(swap => swap.from === seat || swap.to === seat);
  }

  #clearSwapsAt(seat) {
    this.#swaps = this.#swaps.filter(swap => swap.from !== seat && swap.to !== seat);
  }

  #exchangeSeats(from, to) {
    const newSeat = seat => seat === from ? to : seat === to ? from : seat;
    [this.players[from], this.players[to]] = [this.players[to], this.players[from]];
    this.hostSeat = newSeat(this.hostSeat);
    for (const [id, seat] of this.connections) this.connections.set(id, newSeat(seat));
    this.#clearSwapsAt(from);
    this.#clearSwapsAt(to);
    this.revision++;
  }

  moveSeat(connectionId, targetSeat, revision) {
    const currentSeat = this.#lobbySeat(connectionId, revision);
    if (!validSeat(targetSeat)) throw new Error('유효하지 않은 자리입니다.');
    if (targetSeat === currentSeat) return false;
    if (this.players[targetSeat]) throw new Error('이미 다른 참가자가 선택한 자리입니다.');
    this.#exchangeSeats(currentSeat, targetSeat);
    return true;
  }

  requestSeatSwap(connectionId, targetSeat, revision) {
    const from = this.#lobbySeat(connectionId, revision);
    if (!validSeat(targetSeat) || targetSeat === from || !this.players[targetSeat]) {
      throw new Error('교환을 요청할 다른 참가자의 자리를 선택해 주세요.');
    }
    if (this.#swapAt(from) || this.#swapAt(targetSeat)) {
      throw new Error('이미 자리 교환 요청이 진행 중입니다.');
    }
    this.#swaps.push({from, to: targetSeat});
    this.revision++;
    return true;
  }

  answerSeatSwap(connectionId, accepted, revision) {
    const seat = this.#lobbySeat(connectionId, revision);
    const swap = this.#swapAt(seat);
    if (swap?.to !== seat || typeof accepted !== 'boolean') throw new Error('응답할 자리 교환 요청을 확인해 주세요.');
    if (accepted) this.#exchangeSeats(swap.from, swap.to);
    else {
      this.#clearSwapsAt(seat);
      this.revision++;
    }
    return true;
  }

  cancelSeatSwap(connectionId, revision) {
    const seat = this.#lobbySeat(connectionId, revision);
    if (this.#swapAt(seat)?.from !== seat) throw new Error('취소할 자리 교환 요청이 없습니다.');
    this.#clearSwapsAt(seat);
    this.revision++;
    return true;
  }

  botPlayer(seat) {
    return {name: 'AI ' + BOT_NAMES[seat], bot: true};
  }

  setRules(rules) {
    if (this.round) throw new Error('규칙은 대기실에서 변경할 수 있습니다.');
    this.rules = validateRules(rules, this.rules);
    this.revision++;
  }

  start() {
    if (this.round && this.round.phase !== 'result') throw new Error('이미 게임이 진행 중입니다.');
    this.players = this.players.map((p, i) => p ?? this.botPlayer(i));
    this.round = createGame({firstSeat: this.roundNumber % 5, rules: this.rules});
    this.#swaps = [];
    this.roundNumber++;
    this.revision++;
  }

  returnToRoom() {
    if (this.round?.phase !== 'result') throw new Error('게임을 끝낸 후 대기실로 돌아갈 수 있습니다.');
    this.round = null;
    this.players = this.players.map(p => p?.bot ? null : p);
    this.revision++;
  }

  act(seat, revision, action) {
    if (!this.round || !Number.isInteger(seat) || seat < 0 || seat > 4 || this.players[seat]?.bot) throw new Error('플레이어 자리를 확인해 주세요.');
    if (revision !== this.revision) throw new Error('테이블 상태가 바뀌었습니다. 다시 선택해 주세요.');
    this.#applyTurn(seat, action);
  }

  get botTurn() {
    return Boolean(this.round && this.round.phase !== 'result' && this.players[this.round.turn]?.bot);
  }

  runBot(action) {
    if (!this.botTurn) return;
    const seat = this.round.turn;
    this.#applyTurn(seat, action ?? botAction(this.round, seat));
  }

  #applyTurn(seat, action) {
    applyAction(this.round, seat, action);
    if (action.type === 'bid' || action.type === 'pass') {
      const entry = this.round.bidHistory.at(-1);
      if (entry) entry.name = this.players[seat].name;
    }
    this.revision++;
  }

  view(seat) {
    if (!validSeat(seat)) throw new Error('유효하지 않은 자리입니다.');
    const swap = this.#swapAt(seat);
    return {revision: this.revision, seat, hostSeat: this.hostSeat, swap: swap ? {...swap} : null,
      rules: {...this.rules}, players: this.players.map(p => p && {...p}),
      game: this.round ? getView(this.round, seat) : null};
  }
}
