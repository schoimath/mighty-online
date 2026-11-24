import {applyAction, botAction, createGame, getView} from './engine.js';

const BOT_NAMES = ['솔', '달', '별', '구름', '바다'];

export class HostSession {
  constructor(hostName) {
    this.players = [{name: hostName, bot: false}, null, null, null, null];
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
    this.players[seat] = this.round ? this.botPlayer(seat) : null;
    this.revision++;
  }

  botPlayer(seat) {
    return {name: 'AI ' + BOT_NAMES[seat], bot: true};
  }

  start() {
    if (this.round && this.round.phase !== 'result') throw new Error('이미 게임이 진행 중입니다.');
    this.players = this.players.map((p, i) => p ?? this.botPlayer(i));
    this.round = createGame({firstSeat: this.roundNumber % 5});
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
    applyAction(this.round, seat, action);
    this.revision++;
  }

  get botTurn() {
    return Boolean(this.round && this.round.phase !== 'result' && this.players[this.round.turn]?.bot);
  }

  runBot() {
    if (!this.botTurn) return;
    const seat = this.round.turn;
    applyAction(this.round, seat, botAction(this.round, seat));
    this.revision++;
  }

  view(seat) {
    if (!Number.isInteger(seat) || seat < 0 || seat > 4) throw new Error('유효하지 않은 자리입니다.');
    return {revision: this.revision, seat, players: this.players.map(p => p && {...p}),
      game: this.round ? getView(this.round, seat) : null};
  }
}
