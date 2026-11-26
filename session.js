import {botObservation, DEFAULT_RULES, legalPlays, validateRules} from './engine.js';
import {applyAction, canDeclareSetting, createGame, getView, getSpectatorView, resolveSetting} from './table-deal.js';
import {jokerWasPlayed, withJokerStatus} from './table-joker.js';
import {shouldDeclareSetting} from './bot-setting.js';
import {settlements, TABLE_SCORING_VERSION} from './table-scoring.js';
import {normalizeGameSpeed} from './table-timing.js';
import {commonModelChoice, decideTableTurn, hasSeatMemory, isModelId, memoryForReplacement, modelsForChoice} from './lab/table-agents.js';

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
  #nextBidder = {seat: 0, memberId: null};
  #hostName;
  #hostMemberId = 'host';
  #nextGuest = 1;
  #botIds = BOT_NAMES.map((_, seat) => 'bot-' + seat);
  #nextBot = 1;
  #observers = new Map();
  #observerMembers = new Map();
  #queue = [];
  #departingGuests = new Set();
  #dealtPlayers = null;
  #members = new Map();
  #roundMembers = null;
  #completedRounds = 0;
  #roundLimit;
  #lastSettlement = new Map();
  #botMemory = Array(5).fill(null);
  #guestDecisions = Array.from({length:5}, () => []);
  #claim = null;
  #skipBotClaim = false;
  chipHandId = null;
  #chipRevision = -1;

  constructor(hostName, rules = DEFAULT_RULES, botModels, roundLimit = null, {publicRoom = false, hostSpectator = false, pace, modelChoice = commonModelChoice(botModels)} = {}) {
    this.publicRoom = publicRoom === true;
    this.pace = normalizeGameSpeed(pace);
    this.#hostName = hostName;
    this.players = Array(5).fill(null);
    this.hostSeat = this.publicRoom && hostSpectator ? -1 : 0;
    if (this.hostSeat < 0) this.#observers.set(null,hostName);
    else this.players[this.hostSeat] = this.#player('host', hostName, false);
    this.rules = validateRules(rules);
    this.botModels = validateBotModels(botModels === undefined ? modelsForChoice(modelChoice) : botModels);
    this.modelChoice = modelChoice;
    this.#roundLimit = validateRoundLimit(roundLimit);
    this.connections = new Map();
    this.revision = 0;
    this.round = null;
  }

  seatFor(id) {
    return this.connections.get(id) ?? -1;
  }

  hasSeatOrReservation(id) {
    return (id === null ? this.hostSeat : this.seatFor(id)) >= 0 || this.#queue.some(entry => entry.id === id);
  }

  nameFor(id) {
    if (id === null) return this.#hostName;
    return this.#observers.get(id) ?? this.players[this.seatFor(id)]?.name;
  }

  // Only a server-owned hand has a transferable round. The local practice
  // engine contains the deck, all hands and the private claim solver position.
  handoffState() {
    let round = null;
    if (this.round) {
      const game = this.round;
      if (!this.chipHandId || game.seat !== -1 || game.selfRole !== 'spectator' ||
          game.hand?.length !== 0 || game.discarded?.length !== 0) return null;
      const fields = ['phase','turn','dealNo','rules','counts','passed','bid','bidHistory','declarer','friendKnown',
        'friend','call','trick','trickNo','lastTrick','result','scores','captured','misdealCount','settingAwaitingFriend',
        'settingPenaltyCards','jokerPlayed'];
      round = {seat:-1, selfRole:'spectator', hand:[], discarded:[],
        choices:{canPass:false, bids:[], discard:false, contracts:[], friends:[], plays:[], canDeclareSetting:false}};
      for (const key of fields) if (Object.hasOwn(game,key)) round[key] = game[key];
    }
    return structuredClone({version:1, publicRoom:this.publicRoom, rules:this.rules, pace:this.pace,
      models:this.botModels, modelChoice:this.modelChoice, roundLimit:this.#roundLimit, revision:this.revision, hostSeat:this.hostSeat,
      hostMemberId:this.#hostMemberId,
      players:this.players, connections:[...this.connections], observers:[...this.#observers],
      observerMembers:[...this.#observerMembers], queue:this.#queue, departing:[...this.#departingGuests],
      swaps:this.#swaps, nextGuest:this.#nextGuest, botIds:this.#botIds, nextBot:this.#nextBot,
      members:[...this.#members], roundMembers:this.#roundMembers, dealtPlayers:this.#dealtPlayers,
      completedRounds:this.#completedRounds, lastSettlement:[...this.#lastSettlement], nextBidder:this.#nextBidder,
      chipHandId:this.chipHandId, chipRevision:this.#chipRevision, round});
  }

  isDeparting(id) { return this.#departingGuests.has(id); }

  static takeOver(checkpoint, connectionId, committedDeal = null) {
    const state = structuredClone(checkpoint);
    if (state?.version !== 1 || connectionId == null || state.players?.length !== BOT_NAMES.length ||
        (state.round && (!state.chipHandId || state.round.seat !== -1 || state.round.selfRole !== 'spectator' ||
          state.round.hand?.length !== 0 || state.round.discarded?.length !== 0))) {
      throw new Error('이어받을 방 정보를 확인해 주세요.');
    }
    const peers = new Map(state.connections), observers = new Map(state.observers);
    const name = state.players[state.hostSeat]?.name ?? observers.get(null);
    const session = new HostSession(name,state.rules,state.models,state.roundLimit,{publicRoom:state.publicRoom,pace:state.pace,modelChoice:state.modelChoice});
    session.hostSeat = state.hostSeat;
    session.players = state.players;
    session.connections = peers;
    session.#observers = observers;
    session.#observerMembers = new Map(state.observerMembers);
    session.#nextGuest = state.nextGuest;
    session.#hostMemberId = state.hostMemberId ?? state.players[state.hostSeat]?.memberId ?? 'host';
    session.#queue = state.queue;
    session.#departingGuests = new Set(state.departing);
    session.#swaps = state.swaps;
    session.#botIds = state.botIds;
    session.#nextBot = state.nextBot;
    session.#members = new Map(state.members);
    session.#roundMembers = state.roundMembers;
    session.#dealtPlayers = state.dealtPlayers;
    session.#completedRounds = state.completedRounds;
    session.#lastSettlement = new Map(state.lastSettlement);
    session.#nextBidder = state.nextBidder;
    session.chipHandId = state.chipHandId;
    session.#chipRevision = state.chipRevision;
    session.round = state.round;
    session.revision = state.revision;
    // A deal can commit between the last checkpoint and the founder leaving.
    // Seat reservations and record the original roster before transferring control.
    if (committedDeal) session.startChipHand(committedDeal);
    const formerSeat = session.hostSeat, seat = peers.get(connectionId);
    if (!(validSeat(seat) && session.players[seat] && !session.players[seat].bot) && !(seat === -1 && observers.has(connectionId))) {
      throw new Error('방을 이어받을 참가자를 확인해 주세요.');
    }
    session.#hostName = session.nameFor(connectionId);
    session.#hostMemberId = validSeat(seat) ? session.players[seat].memberId :
      session.#observerMembers.get(connectionId) ?? 'guest-' + session.#nextGuest++;
    peers.delete(connectionId);
    observers.delete(null);
    observers.delete(connectionId);
    session.#observerMembers.delete(null);
    session.#observerMembers.delete(connectionId);
    session.hostSeat = seat;
    if (seat === -1) observers.set(null,session.#hostName);
    session.#queue = session.#queue.filter(entry => entry.id !== null)
      .map(entry => entry.id === connectionId ? {...entry,id:null} : entry);
    session.#departingGuests.delete(null);
    if (session.#departingGuests.delete(connectionId)) session.#departingGuests.add(null);
    session.revision++;
    if (validSeat(formerSeat)) session.#releaseSeat(formerSeat);
    else session.#updateReservations();
    return session;
  }

  publicSummary() {
    if (!this.publicRoom) return null;
    const finished = this.round?.phase === 'result';
    const seats = this.players.map(player => player && !player.bot ? player.name : null);
    return {
      hostName:this.#hostName, phase:!this.round ? 'waiting' : finished ? 'finished' : 'playing',
      seats, humanCount:seats.filter(name => name !== null).length, spectatorCount:this.#observers.size,
      reservationCount:this.#queue.length, roundNumber:this.#completedRounds + (finished ? 0 : 1), roundLimit:this.#roundLimit
    };
  }

  #player(memberId, name, bot) {
    if (!this.#members.has(memberId)) {
      this.#members.set(memberId, {id: memberId, name, bot, total: 0, rounds: 0});
    }
    return {memberId, name, bot};
  }

  addGuest(id, name, intent = 'play') {
    if (!this.publicRoom && this.round) return '진행 중인 게임입니다. 다음 판에 참가해 주세요.';
    if (id == null) return '참가자 연결을 확인해 주세요.';
    if (this.connections.has(id)) return '이미 입장한 연결입니다.';
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 16) return '닉네임은 1~16자로 입력해 주세요.';
    if (!['play','watch','reserve'].includes(intent)) return '참가 방식을 확인해 주세요.';
    if (!this.publicRoom && intent !== 'play') return '공개 테이블에서 관전하거나 자리를 예약할 수 있습니다.';
    if (this.publicRoom) {
      this.connections.set(id, -1);
      this.#observers.set(id, name.trim());
      if (intent !== 'watch') this.setReservation(id, true);
      return null;
    }
    const seat = this.players.indexOf(null);
    if (seat < 0) return '다섯 자리가 모두 찼습니다.';
    this.connections.set(id, seat);
    this.players[seat] = this.#player('guest-' + this.#nextGuest++, name.trim(), false);
    this.revision++;
    return null;
  }

  setReservation(id, wanted) {
    if (!this.#observers.has(id) || typeof wanted !== 'boolean') {
      throw new Error('관전 중인 공개 테이블에서 자리를 예약할 수 있습니다.');
    }
    const index = this.#queue.findIndex(entry => entry.id === id);
    if (wanted === (index >= 0)) return false;
    if (wanted) this.#queue.push({id, seat:null});
    else this.#queue.splice(index, 1);
    if (this.#updateReservations()) this.revision++;
    return true;
  }

  takeOpenSeat(id, seat, revision) {
    if (!this.publicRoom || this.round || !this.#observers.has(id)) {
      throw new Error('공개 대기실에서 관전 중일 때 빈자리에 앉을 수 있습니다.');
    }
    if (!validSeat(seat)) throw new Error('유효하지 않은 자리입니다.');
    if (this.players[seat]) throw new Error('이미 다른 참가자가 선택한 자리입니다.');
    if (revision !== this.revision) throw new Error('대기실 상태가 바뀌었습니다. 다시 선택해 주세요.');
    this.#seatObserver(id, seat);
    this.#queue = this.#queue.filter(entry => entry.id !== id);
    this.revision++;
    return true;
  }

  // Seat assignments are stable once shown on the result screen. The current
  // hand and its settlement still belong to the players who were dealt in.
  #updateReservations() {
    if (!this.#queue.length || (this.round && this.round.phase !== 'result')) return;
    const assigned = new Set(this.#queue.map(entry => entry.seat));
    const open = BOT_NAMES.map((_, i) => i).filter(seat =>
      !assigned.has(seat) && (!this.players[seat] || this.players[seat].bot));
    for (const entry of this.#queue) {
      if (entry.seat === null && open.length) entry.seat = open.shift();
    }
    return !this.round && this.#seatReservedPlayers();
  }

  #seatReservedPlayers() {
    const ready = this.#queue.filter(entry => entry.seat !== null);
    for (const {id, seat} of ready) this.#seatObserver(id, seat);
    this.#queue = this.#queue.filter(entry => entry.seat === null);
    return ready.length;
  }

  #seatObserver(id, seat) {
    const memberId = id === null ? this.#hostMemberId : this.#observerMembers.get(id) ?? 'guest-' + this.#nextGuest++;
    this.players[seat] = this.#player(memberId, this.#observers.get(id), false);
    if (id === null) this.hostSeat = seat;
    else this.connections.set(id, seat);
    this.#observers.delete(id);
    this.#observerMembers.delete(id);
  }

  removeGuest(id) {
    if (id == null) return;
    this.#departingGuests.delete(id);
    this.#observerMembers.delete(id);
    if (this.#observers.delete(id)) {
      this.connections.delete(id);
      this.#queue = this.#queue.filter(entry => entry.id !== id);
      this.#updateReservations();
      return;
    }
    const seat = this.seatFor(id);
    if (seat < 0) return;
    this.connections.delete(id);
    this.#releaseSeat(seat);
  }

  setGuestDeparture(id, handId, wanted) {
    if (!handId || handId !== this.chipHandId || !this.round ||
        this.seatFor(id) < 0 || typeof wanted !== 'boolean') return false;
    // A guest can still be playing the last trick on screen after the host has
    // received its receipt. Honor the request before building the next table.
    if (this.round.result) return wanted && this.sitOut(id);
    if (wanted) this.#departingGuests.add(id);
    else this.#departingGuests.delete(id);
    return true;
  }

  leaveHostSeat() {
    if (!this.publicRoom || !validSeat(this.hostSeat) || !this.round || this.round.phase === 'result') {
      throw new Error('진행 중인 공개 테이블에서 방장 자리를 AI에게 넘길 수 있습니다.');
    }
    const seat = this.hostSeat;
    this.hostSeat = -1;
    this.#observers.set(null, this.#hostName);
    this.#releaseSeat(seat);
    return true;
  }

  // A player who is out of chips can keep watching this table, including
  // an invitation-only table. Keep the original hand owner in the ledger.
  sitOut(id) {
    const seat = id === null ? this.hostSeat : this.seatFor(id);
    if (!validSeat(seat)) {
      if (this.#observers.has(id)) return this.setReservation(id, false);
      return false;
    }
    this.#observers.set(id, this.players[seat].name);
    if (id !== null) this.#observerMembers.set(id,this.players[seat].memberId);
    if (id === null) this.hostSeat = -1;
    else this.connections.set(id, -1);
    this.#releaseSeat(seat);
    return true;
  }

  #releaseSeat(seat) {
    const memberId = this.players[seat].memberId;
    if (memberId === this.#nextBidder.memberId) this.#nextBidder.seat = seat;
    if (!this.round && !this.#members.get(memberId).rounds) this.#members.delete(memberId);
    this.#clearSwapsAt(seat);
    if ((this.publicRoom || this.chipHandId) && this.#members.get(this.#botIds[seat])?.rounds) {
      this.#botIds[seat] = 'sub-' + this.#nextBot++;
    }
    this.players[seat] = this.round ? this.botPlayer(seat) : null;
    if (!this.chipHandId && this.round && this.round.phase !== 'result' && hasSeatMemory(this.botModels[seat])) {
      this.#botMemory[seat] = memoryForReplacement(this.botModels[seat], this.#guestDecisions[seat]);
      this.#guestDecisions[seat] = [];
    }
    this.#updateReservations();
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
    const player = this.#player(this.#botIds[seat], 'AI ' + BOT_NAMES[seat], true);
    return {...player, modelId: this.botModels[seat]};
  }

  setBotModels(models) {
    if (this.round) throw new Error('AI 모델은 대기실에서 변경할 수 있습니다.');
    this.botModels = validateBotModels(models);
    this.modelChoice = commonModelChoice(models);
    this.revision++;
  }

  setModelChoice(choice) {
    if (choice === this.modelChoice) return;
    this.setBotModels(modelsForChoice(choice));
    this.modelChoice = choice;
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

  setPace(pace) {
    const next = normalizeGameSpeed(pace);
    if (this.pace === next) return;
    this.pace = next;
    // A local card choice or an AI calculation already in flight stays valid.
    if (!this.round) this.revision++;
  }

  get #complete() {
    return this.#roundLimit !== null && this.#completedRounds >= this.#roundLimit;
  }

  plannedTable() {
    if (this.#complete) throw new Error('목표 판수를 모두 마쳤습니다. 새 대국을 시작해 주세요.');
    if (this.round && this.round.phase !== 'result') throw new Error('이미 게임이 진행 중입니다.');
    const returningBidder = this.#queue.find(({id,seat}) => seat !== null &&
      (id === null ? this.#hostMemberId : this.#observerMembers.get(id)) === this.#nextBidder.memberId);
    const bidderSeat = returningBidder?.seat ?? this.players.findIndex(p => p && p.memberId === this.#nextBidder.memberId);
    const firstSeat = bidderSeat < 0 ? this.#nextBidder.seat : bidderSeat;
    const seats = this.players.map((player, seat) => {
      const queued = this.#queue.find(entry => entry.seat === seat);
      if (queued) return {id:queued.id, name:this.#observers.get(queued.id)};
      if (!player || player.bot) return {bot:true, name:'AI ' + BOT_NAMES[seat]};
      const id = seat === this.hostSeat ? null : Array.from(this.connections).find(([, n]) => n === seat)?.[0];
      return {id, name:player.name};
    });
    return {seats, firstSeat, models:[...this.botModels], rules:{...this.rules}, pace:this.pace};
  }

  start() {
    const {firstSeat} = this.plannedTable();
    this.#deal(createGame({firstSeat, rules:this.rules}));
  }

  #deal(round) {
    this.#seatReservedPlayers();
    this.round = round;
    this.#resetBotMemory();
    this.players = this.players.map((p, i) => p ?? this.botPlayer(i));
    this.#dealtPlayers = (this.publicRoom || this.chipHandId) ? [...this.players] : null;
    // A substitute finishes on behalf of the member who received the original hand.
    this.#roundMembers = this.players.map(player => player.memberId);
    this.#swaps = [];
    this.revision++;
  }

  startChipHand(reply) {
    if (this.chipHandId && reply.handId === this.chipHandId) {
      this.syncChipHand(reply);
      return;
    }
    this.plannedTable();
    if (reply.publicGame?.seat !== -1 || !reply.handId) throw new Error('서버의 공개 테이블 정보를 확인해 주세요.');
    this.chipHandId = reply.handId;
    this.#chipRevision = -1;
    this.#deal(reply.publicGame);
    this.syncChipHand(reply);
  }

  syncChipHand(reply) {
    if (reply.handId !== this.chipHandId || reply.revision <= this.#chipRevision || reply.publicGame?.seat !== -1) return false;
    this.#chipRevision = reply.revision;
    if (!this.round?.result || !reply.publicGame.result) this.pace = normalizeGameSpeed(reply.pace);
    this.round = reply.publicGame;
    for (let seat = 0; seat < 5; seat++) {
      if (reply.bots[seat] && this.players[seat] && !this.players[seat].bot) {
        const id = seat === this.hostSeat ? null : Array.from(this.connections).find(([, n]) => n === seat)?.[0];
        if (id !== undefined) this.sitOut(id);
      }
    }
    this.#recordResult();
    this.revision++;
    return true;
  }

  returnToRoom() {
    if (this.round?.phase !== 'result') throw new Error('게임을 끝낸 후 대기실로 돌아갈 수 있습니다.');
    this.round = null;
    this.chipHandId = null;
    this.#chipRevision = -1;
    this.#dealtPlayers = null;
    this.players = this.players.map(p => p?.bot ? null : p);
    if (this.#complete) {
      this.#completedRounds = 0;
      this.#lastSettlement.clear();
      this.#members.clear();
      for (const player of this.players) {
        if (player) this.#player(player.memberId, player.name, player.bot);
      }
      this.#nextBidder = {seat:0, memberId:null};
    }
    this.#updateReservations();
    this.revision++;
  }

  act(seat, revision, action) {
    if (this.chipHandId) throw new Error('칩 대국의 수는 게임 서버에서 처리합니다.');
    if (!this.round || !Number.isInteger(seat) || seat < 0 || seat > 4 || this.players[seat]?.bot) throw new Error('플레이어 자리를 확인해 주세요.');
    if (revision !== this.revision) throw new Error('테이블 상태가 바뀌었습니다. 다시 선택해 주세요.');
    if (this.#claim) throw new Error('세팅을 판정하고 있습니다.');
    if (action?.type === 'claim') return this.#beginClaim(seat);
    this.#applyTurn(seat, action);
  }

  #beginClaim(seat) {
    if (!canDeclareSetting(this.round, seat)) throw new Error('세팅은 1~9번째 트릭에서 주공이 선을 잡고 카드를 내기 전에 선언할 수 있습니다.');
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
    return Boolean(!this.chipHandId && !this.#claim && this.round && this.round.phase !== 'result' && this.players[this.round.turn]?.bot);
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
    // Keep only the departing player's own decision history for a possible
    // mid-round recurrent substitute. These records never enter a room view.
    const track = (this.publicRoom || seat !== this.hostSeat) && !this.players[seat].bot && hasSeatMemory(this.botModels[seat]);
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
      const opener = this.round.result.friend ?? this.round.result.declarer;
      this.#nextBidder = {seat: opener, memberId: this.#roundMembers[opener]};
      this.#roundMembers = null;
      // The outgoing guest owns the hand just settled. Release the seat before
      // a spectator is assigned or the host can offer another chip hand.
      for (const id of this.#departingGuests) this.sitOut(id);
      this.#departingGuests.clear();
      this.#updateReservations();
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
    const board = {scoringVersion: TABLE_SCORING_VERSION, rounds: this.#completedRounds,
      roundLimit:this.#roundLimit, complete:this.#complete, members};
    if (this.round?.result && this.#dealtPlayers) board.panelMemberIds = this.#dealtPlayers.map(p => p.memberId);
    return board;
  }

  view(seat) {
    if (!validSeat(seat)) throw new Error('유효하지 않은 자리입니다.');
    return this.#view(seat);
  }

  viewFor(id) {
    if (!this.connections.has(id)) throw new Error('참가자 연결을 확인해 주세요.');
    return this.#view(this.seatFor(id), id);
  }

  hostView() {
    return this.#view(this.hostSeat, null);
  }

  #view(seat, id) {
    const swap = this.#swapAt(seat);
    const spectator = seat === -1;
    const projection = this.round && (this.chipHandId ? this.round : spectator ? getSpectatorView(this.round) : getView(this.round, seat));
    const game = this.chipHandId ? projection : projection && withJokerStatus(projection, jokerWasPlayed(this.round));
    if (game && this.#claim) {
      game.claimPending = true;
      game.turn = null;
      game.choices.canDeclareSetting = false;
      game.choices.plays = [];
    }
    if (!this.chipHandId && game?.phase === 'discard' && seat === game.declarer) {
      game.incomingCards = [...(this.round.knownKitty || [])];
    }
    const positions = new Map(this.#queue.map(({id, seat}, i) => [id, {position:i + 1, seat}]));
    const spectators = Array.from(this.#observers, ([id, name]) => ({name, position:null, seat:null, ...positions.get(id)}));
    const roster = game?.result && this.#dealtPlayers ? this.#dealtPlayers : this.players;
    return {revision: this.revision, chipHandId:this.chipHandId, chipRevision:this.#chipRevision, seat, hostSeat: this.hostSeat, swap: swap ? {...swap} : null,
      publicRoom:this.publicRoom, spectator, spectators, reservation:positions.get(id) ?? null, supportsReservedExit:true,
      supportsOpenSeatChoice:this.publicRoom,
      rules: {...this.rules}, pace:this.pace, botModels: [...this.botModels], modelChoice:this.modelChoice, players: roster.map(p => p && {...p}),
      scoreboard: this.#scoreboard(), game};
  }
}
