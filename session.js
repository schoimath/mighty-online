import {botObservation, DEFAULT_RULES, legalPlays, validateRules} from './engine.js';
import {applyAction, canDeclareSetting, createGame, getView, resolveSetting} from './table-deal.js';
import {jokerWasPlayed, withJokerStatus} from './table-joker.js';
import {shouldDeclareSetting} from './bot-setting.js';
import {settlements, TABLE_SCORING_VERSION} from './table-scoring.js';
import {decideTableTurn, hasSeatMemory, isModelId, memoryForReplacement, randomSeatModels} from './lab/table-agents.js';

const BOT_NAMES = ['솔', '달', '별', '구름', '바다'];
const validSeat = seat => Number.isInteger(seat) && seat >= 0 && seat < BOT_NAMES.length;

function validateBotModels(models) {
  if (!Array.isArray(models) || models.length !== BOT_NAMES.length || !Array.from(models).every(isModelId)) {
    throw new Error('다섯 자리의 AI 모델을 확인해 주세요.');
  }
  return [...models];
}

function validateRoundLimit(limit) {
  if (limit !== null && limit !== 10 && limit !== 20) throw new Error('대국 길이는 10판, 20판, 무제한 중에서 선택해 주세요.');
  return limit;
}

export class HostSession {
  #swaps = [];
  #nextBidder = {seat: 0, player: null};
  #nextGuest = 1;
  #members = new Map();
  #roundMembers = null;
  #completedRounds = 0;
  #roundLimit;
  #lastSettlement = new Map();
  #botMemory = Array(5).fill(null);
  #guestDecisions = Array.from({length:5}, () => []);
  #claim = null;
  #skipBotClaim = false;

  constructor(hostName, rules = DEFAULT_RULES, botModels = randomSeatModels(), roundLimit = null) {
    this.players = [this.#player('host', hostName, false), null, null, null, null];
    this.hostSeat = 0;
    this.rules = validateRules(rules);
    this.botModels = validateBotModels(botModels);
    this.#roundLimit = validateRoundLimit(roundLimit);
    this.connections = new Map();
    this.revision = 0;
    this.round = null;
  }

  seatFor(id) {
    return this.connections.get(id) ?? -1;
  }

  #player(memberId, name, bot) {
    if (!this.#members.has(memberId)) {
      this.#members.set(memberId, {id: memberId, name, bot, total: 0, rounds: 0});
    }
    return {memberId, name, bot};
  }

  addGuest(id, name) {
    if (this.round) return '진행 중인 게임입니다. 다음 판에 참가해 주세요.';
    if (id == null) return '참가자 연결을 확인해 주세요.';
    if (this.connections.has(id)) return '이미 입장한 연결입니다.';
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 16) return '닉네임은 1~16자로 입력해 주세요.';
    const seat = this.players.indexOf(null);
    if (seat < 0) return '다섯 자리가 모두 찼습니다.';
    this.connections.set(id, seat);
    this.players[seat] = this.#player('guest-' + this.#nextGuest++, name.trim(), false);
    this.revision++;
    return null;
  }

  removeGuest(id) {
    const seat = this.seatFor(id);
    if (seat < 0) return;
    if (this.players[seat] === this.#nextBidder.player) this.#nextBidder.seat = seat;
    const memberId = this.players[seat].memberId;
    if (!this.round && !this.#members.get(memberId).rounds) this.#members.delete(memberId);
    this.connections.delete(id);
    this.#clearSwapsAt(seat);
    this.players[seat] = this.round ? this.botPlayer(seat) : null;
    if (this.round && this.round.phase !== 'result' && hasSeatMemory(this.botModels[seat])) {
      this.#botMemory[seat] = memoryForReplacement(this.botModels[seat], this.#guestDecisions[seat]);
      this.#guestDecisions[seat] = [];
    }
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
    const player = this.#player('bot-' + seat, 'AI ' + BOT_NAMES[seat], true);
    return {...player, modelId: this.botModels[seat]};
  }

  setBotModels(models) {
    if (this.round) throw new Error('AI 모델은 대기실에서 변경할 수 있습니다.');
    this.botModels = validateBotModels(models);
    this.revision++;
  }

  setRules(rules) {
    if (this.round) throw new Error('규칙은 대기실에서 변경할 수 있습니다.');
    this.rules = validateRules(rules, this.rules);
    this.revision++;
  }

  setRoundLimit(limit) {
    validateRoundLimit(limit);
    if (limit === this.#roundLimit) return;
    if (this.round || this.#completedRounds) throw new Error('대국 길이는 첫 판을 시작하기 전에만 변경할 수 있습니다.');
    this.#roundLimit = limit;
    this.revision++;
  }

  get #complete() {
    return this.#roundLimit !== null && this.#completedRounds >= this.#roundLimit;
  }

  start() {
    if (this.#complete) throw new Error('목표 판수를 모두 마쳤습니다. 새 대국을 시작해 주세요.');
    if (this.round && this.round.phase !== 'result') throw new Error('이미 게임이 진행 중입니다.');
    const players = this.players.map((p, i) => p ?? this.botPlayer(i));
    const bidderSeat = players.indexOf(this.#nextBidder.player);
    const firstSeat = bidderSeat < 0 ? this.#nextBidder.seat : bidderSeat;
    this.round = createGame({firstSeat, rules: this.rules});
    this.#resetBotMemory();
    this.players = players;
    // A substitute finishes on behalf of the member who received the original hand.
    this.#roundMembers = this.players.map(player => player.memberId);
    this.#swaps = [];
    this.revision++;
  }

  returnToRoom() {
    if (this.round?.phase !== 'result') throw new Error('게임을 끝낸 후 대기실로 돌아갈 수 있습니다.');
    this.round = null;
    this.players = this.players.map(p => p?.bot ? null : p);
    if (this.#complete) {
      this.#completedRounds = 0;
      this.#lastSettlement.clear();
      this.#members.clear();
      for (const player of this.players) {
        if (player) this.#player(player.memberId, player.name, player.bot);
      }
      this.#nextBidder = {seat:0, player:null};
    }
    this.revision++;
  }

  act(seat, revision, action) {
    if (!this.round || !Number.isInteger(seat) || seat < 0 || seat > 4 || this.players[seat]?.bot) throw new Error('플레이어 자리를 확인해 주세요.');
    if (revision !== this.revision) throw new Error('테이블 상태가 바뀌었습니다. 다시 선택해 주세요.');
    if (this.#claim) throw new Error('세팅을 판정하고 있습니다.');
    if (action?.type === 'claim') return this.#beginClaim(seat);
    this.#applyTurn(seat, action);
  }

  #beginClaim(seat) {
    if (!canDeclareSetting(this.round, seat)) throw new Error('주공이 선을 잡았을 때 세팅을 선언할 수 있습니다.');
    const {phase, turn, declarer, trickNo, trick, hands, bid, rules} = this.round;
    // This position goes only to the host's local solver. Peers receive view().
    this.#claim = structuredClone({phase, turn, declarer, trickNo, trick, hands, bid, rules});
    this.revision++;
    return this.#claim;
  }

  tryBotClaim() {
    if (!this.botTurn || this.#skipBotClaim || !canDeclareSetting(this.round, this.round.turn)) return null;
    const view = botObservation(this.round, this.round.turn);
    return shouldDeclareSetting(view) ? this.#beginClaim(view.seat) : null;
  }

  finishClaim(position, verdict) {
    if (!position || this.#claim !== position) return false;
    resolveSetting(this.round, this.round.declarer, verdict);
    this.#claim = null;
    this.#recordResult();
    this.revision++;
    return true;
  }

  abandonClaim(position) {
    if (!position || this.#claim !== position) return false;
    this.#claim = null;
    this.#skipBotClaim = Boolean(this.players[position.declarer]?.bot);
    this.revision++;
    return true;
  }

  get botTurn() {
    return Boolean(!this.#claim && this.round && this.round.phase !== 'result' && this.players[this.round.turn]?.bot);
  }

  botRequest(seed) {
    if (!this.botTurn) return null;
    const seat = this.round.turn, modelId = this.players[seat].modelId;
    const request = {revision:this.revision, seed, modelId, view:withJokerStatus(botObservation(this.round, seat))};
    if (hasSeatMemory(modelId)) request.memory = structuredClone(this.#botMemory[seat]);
    return request;
  }

  runBot(action, seed, memory) {
    if (!this.botTurn) return;
    const seat = this.round.turn;
    if (action == null) {
      ({action, memory} = decideTableTurn(this.botRequest(seed)));
    }
    this.#applyTurn(seat, action, memory);
  }

  #resetBotMemory() {
    this.#skipBotClaim = false;
    this.#botMemory.fill(null);
    this.#guestDecisions = Array.from({length:5}, () => []);
  }

  #applyTurn(seat, action, memory) {
    const dealNo = this.round.dealNo;
    // Keep only the departing guest's own decision history for a possible
    // mid-round recurrent substitute. These records never enter a room view.
    const track = seat !== this.hostSeat && !this.players[seat].bot && hasSeatMemory(this.botModels[seat]);
    const observation = track ? withJokerStatus(botObservation(this.round, seat)) : null;
    // Older clients still offer a call after everyone has seen the Joker.
    if (action?.type === 'play' && action.jokerCall === true && this.round.phase === 'play' &&
        jokerWasPlayed(this.round) && legalPlays(this.round, this.round.hands[seat]).some(move =>
          move.jokerCall && move.card === action.card && move.suit === action.suit)) {
      action = {...action, jokerCall:false};
    }
    applyAction(this.round, seat, action);
    this.#skipBotClaim = false;
    if (this.round.dealNo !== dealNo) this.#resetBotMemory();
    else if (track) {
      const entry = {observation};
      if (observation.phase === 'discard') entry.action = {contract:{...this.round.bid}};
      this.#guestDecisions[seat].push(entry);
    }
    else if (memory != null) this.#botMemory[seat] = structuredClone(memory);
    this.#recordResult();
    if (action.type === 'bid' || action.type === 'pass') {
      const entry = this.round.bidHistory.at(-1);
      if (entry) entry.name = this.players[seat].name;
    }
    this.revision++;
  }

  #recordResult() {
    if (this.round.result && this.#roundMembers) {
      const changes = settlements(this.round.result, this.round.bid.suit);
      this.#lastSettlement.clear();
      this.#roundMembers.forEach((id, seat) => {
        const member = this.#members.get(id);
        member.total += changes[seat];
        member.rounds++;
        this.#lastSettlement.set(id, {lastSeat: seat, lastDelta: changes[seat]});
      });
      this.#completedRounds++;
      this.#roundMembers = null;
      const opener = this.round.result.friend ?? this.round.result.declarer;
      this.#nextBidder = {seat: opener, player: this.players[opener]};
    }
  }

  #scoreboard() {
    const members = [];
    for (const member of this.#members.values()) {
      const current = this.players.findIndex(p => p?.memberId === member.id);
      if (current < 0 && !member.rounds && !this.#roundMembers?.includes(member.id)) continue;
      const latest = this.#lastSettlement.get(member.id);
      members.push({...member, seat: current < 0 ? null : current, rank:null,
        lastSeat: latest?.lastSeat ?? null, lastDelta: latest?.lastDelta ?? null});
    }
    if (this.#complete) {
      const ranked = members.filter(member => member.rounds > 0).sort((a, b) => b.total - a.total);
      ranked.forEach((member, i) => {
        const previous = ranked[i - 1];
        member.rank = previous?.total === member.total ? previous.rank : i + 1;
      });
    }
    members.sort((a, b) => (a.seat ?? BOT_NAMES.length) - (b.seat ?? BOT_NAMES.length));
    return {scoringVersion: TABLE_SCORING_VERSION, rounds: this.#completedRounds,
      roundLimit:this.#roundLimit, complete:this.#complete, members};
  }

  view(seat) {
    if (!validSeat(seat)) throw new Error('유효하지 않은 자리입니다.');
    const swap = this.#swapAt(seat);
    const game = this.round ? withJokerStatus(getView(this.round, seat), jokerWasPlayed(this.round)) : null;
    if (game && this.#claim) {
      game.claimPending = true;
      game.turn = null;
      game.choices.canDeclareSetting = false;
      game.choices.plays = [];
    }
    if (game?.phase === 'discard' && seat === game.declarer) {
      game.incomingCards = [...(this.round.knownKitty || [])];
    }
    return {revision: this.revision, seat, hostSeat: this.hostSeat, swap: swap ? {...swap} : null,
      rules: {...this.rules}, botModels: [...this.botModels], players: this.players.map(p => p && {...p}),
      scoreboard: this.#scoreboard(), game};
  }
}
