import assert from 'node:assert/strict';
import test from 'node:test';
import {HostSession} from '../session.js';
import {seatStanding, signedScore} from '../score-ui.js';
import {settlements} from '../table-scoring.js';

const table = roundLimit => new HostSession('방장', undefined, Array(5).fill('heuristic'), roundLimit, {publicRoom:true});

function step(room, action) {
  const {turn} = room.round;
  return room.botTurn ? room.runBot(action) : room.act(turn, room.revision, action);
}

function openPlay(room, friendSeat) {
  step(room, {type:'bid', suit:'H', points:14});
  for (let i = 0; i < 4; i++) step(room, {type:'pass'});
  const declarer = room.round.declarer;
  step(room, {type:'discard', cards:room.view(declarer).game.hand.slice(0, 3)});
  const call = friendSeat === undefined ? {kind:'none'} : {kind:'card',card:room.view(friendSeat).game.hand[0]};
  step(room, {type:'friend', ...call});
}

function finish(room) {
  while (room.round.phase === 'play') {
    const [legal] = room.view(room.round.turn).game.choices.plays;
    step(room, {type:'play', ...legal});
  }
  assert.equal(room.round.phase, 'result');
}

test('the public table creator and entrants can watch, sit or release a waiting-room seat', () => {
  const models=Array(5).fill('heuristic');
  const room=new HostSession('방장',undefined,models,10,{publicRoom:true,hostSpectator:true});
  assert.equal(room.hostView().spectator,true);
  assert.equal(room.publicSummary().humanCount,0);
  assert.equal(room.publicSummary().spectatorCount,1);
  assert.equal(room.hostView().scoreboard.members.length,0);
  room.addGuest('visitor','손님','watch');
  assert.equal(room.plannedTable().seats.every(p=>p.bot),true);
  assert.equal(room.setReservation(null,true),true);
  assert.equal(room.hostSeat,0);
  assert.equal(room.sitOut(null),true);
  assert.equal(room.setReservation('visitor',true),true);
  assert.equal(room.seatFor('visitor'),0);
  assert.equal(room.sitOut('visitor'),true);
  assert.equal(room.publicSummary().spectatorCount,2);
  room.setReservation('visitor',true);
  room.start();
  assert.equal(room.hostView().game.seat,-1);
  assert.deepEqual(room.hostView().game.hand,[]);
  room.addGuest('new','새 관전자','watch');
  assert.equal(room.viewFor('new').reservation,null);
  assert.equal(room.setReservation('new',true),true);
  assert.deepEqual(room.viewFor('new').reservation,{position:1,seat:null});
  assert.equal(new HostSession('초대 방장',undefined,models,10,{hostSpectator:true}).hostSeat,0);
});

test('public observers claim the numbered seat they saw without replacing an occupant or entering the queue', () => {
  const room = new HostSession('방장', undefined, Array(5).fill('heuristic'), 10, {publicRoom:true, hostSpectator:true});
  room.addGuest('one','하나','watch');
  room.addGuest('two','둘','watch');
  assert.equal(room.viewFor('one').supportsOpenSeatChoice, true);
  const opened = room.revision;
  assert.equal(room.takeOpenSeat(null, 4, opened), true);
  assert.equal(room.hostSeat, 4);
  assert.throws(() => room.takeOpenSeat('one', 4, opened), /선택한 자리/);
  assert.throws(() => room.takeOpenSeat('one', 3, opened), /다시 선택/);
  assert.throws(() => room.takeOpenSeat('one', 5, room.revision), /유효하지/);
  assert.throws(() => room.takeOpenSeat('unknown', 2, room.revision), /관전 중/);
  const seen = room.revision;
  room.takeOpenSeat('one',3,seen);
  assert.throws(() => room.takeOpenSeat('two',3,seen), /선택한 자리/);
  assert.equal(room.viewFor('two').reservation, null);
  assert.deepEqual(room.publicSummary().seats, [null,null,null,'하나','방장']);
  room.start();
  assert.equal(room.viewFor('one').game.seat, 3);
  assert.throws(() => room.takeOpenSeat('two', 1, room.revision), /공개 대기실/);
  assert.equal(room.setReservation('two', true), true);
  assert.deepEqual(room.viewFor('two').reservation, {position:1,seat:null});
});

test('a returning spectator keeps their standings when selecting a different seat', () => {
  const room = table(10);
  room.addGuest('friend','친구','watch');
  room.takeOpenSeat('friend',3,room.revision);
  room.start();
  openPlay(room,3);
  finish(room);
  room.returnToRoom();
  const previous = room.players[3].memberId;
  const before = room.viewFor('friend').scoreboard.members.find(member => member.id === previous);
  room.sitOut('friend');
  room.takeOpenSeat('friend',1,room.revision);
  const after = room.viewFor('friend').scoreboard.members.find(member => member.id === previous);
  assert.equal(room.players[1].memberId, previous);
  assert.equal(after.rounds, 1);
  assert.equal(after.total, before.total);
  assert.equal(room.plannedTable().firstSeat, 1);
  assert.equal(room.viewFor('friend').scoreboard.members.filter(member => member.name === '친구').length, 1);
});

test('public lobby seats, full-table FIFO and spectator-only membership', () => {
  const room = table(10);
  assert.deepEqual(room.publicSummary(), {hostName:'방장', phase:'waiting', seats:['방장',null,null,null,null], humanCount:1,
    spectatorCount:0, reservationCount:0, roundNumber:1, roundLimit:10});
  const revision = room.revision;
  assert.equal(room.addGuest('viewer','관전자','watch'), null);
  assert.equal(room.revision, revision);
  assert.equal(room.viewFor('viewer').spectator, true);
  assert.equal(room.viewFor('viewer').game, null);
  assert.deepEqual(room.view(0).spectators, [{name:'관전자',position:null,seat:null}]);
  assert.equal(room.view(0).scoreboard.members.length, 1);
  assert.throws(() => room.moveSeat('viewer',1,room.revision));
  assert.throws(() => room.viewFor('unregistered'));
  assert.ok(room.addGuest('invalid','잘못된 입장','other'));
  assert.equal(room.setReservation('viewer',true), true);
  assert.equal(room.seatFor('viewer'), 1);
  assert.equal(room.viewFor('viewer').spectator, false);
  assert.equal(room.nameFor('viewer'), '관전자');
  assert.deepEqual(room.publicSummary().seats,['방장','관전자',null,null,null]);
  assert.throws(() => room.setReservation('viewer',true));
  for (const id of ['a','b','c','x','y']) assert.equal(room.addGuest(id,id), null);
  assert.deepEqual(room.viewFor('x').reservation, {position:1,seat:null});
  assert.equal(room.nameFor('y'), 'y');
  assert.deepEqual(room.publicSummary().seats,['방장','관전자','a','b','c']);
  assert.equal(room.setReservation('y',true), false);
  room.removeGuest('b');
  assert.equal(room.seatFor('x'), 3);
  assert.deepEqual(room.viewFor('y').reservation, {position:1,seat:null});
  room.removeGuest('y');
  assert.equal(room.nameFor('y'), undefined);
  assert.equal(room.publicSummary().reservationCount, 0);
  assert.equal(room.publicSummary().humanCount, 5);
});

test('spectators get public tricks and covered piles, no hands or controls while a setting is checked', () => {
  const room = table();
  room.start();
  const bidRevision = room.revision;
  assert.equal(room.addGuest('viewer','관전','watch'), null);
  room.addGuest('queue','예약','reserve');
  assert.equal(room.revision, bidRevision);
  const view = () => room.viewFor('viewer').game;
  function checkPrivate() {
    const g = view();
    assert.equal(g.seat, -1);
    assert.equal(g.selfRole, 'spectator');
    assert.deepEqual(g.hand, []);
    assert.deepEqual(g.discarded, []);
    assert.equal(g.incomingCards, undefined);
    assert.equal(g.playedTricks, undefined);
    assert.equal(g.choices.canPass, false);
    assert.equal(g.choices.discard, false);
    for (const key of ['bids','contracts','friends','plays']) assert.deepEqual(g.choices[key], []);
    assert.ok(!g.choices.canDeclareSetting);
    assert.throws(() => room.act(room.seatFor('viewer'),room.revision,{type:'pass'}));
  }
  checkPrivate();
  room.act(0,bidRevision,{type:'bid',suit:'H',points:14});
  for (let i = 0; i < 4; i++) step(room, {type:'pass'});
  checkPrivate();
  assert.equal(view().counts[0],13);
  step(room,{type:'discard',cards:room.view(0).game.hand.slice(0,3)});
  checkPrivate();
  const called = room.view(2).game.hand[0];
  step(room,{type:'friend',kind:'card',card:called});
  assert.equal(room.view(2).game.selfRole, 'friend');
  assert.equal(view().friend, null);
  const position = room.settingCheckPosition();
  assert.ok(position);
  checkPrivate();
  assert.equal(view().claimPending, undefined);
  assert.equal(view().turn, 0);
  assert.equal(view().choices.settingGuaranteed, undefined);
  room.finishSettingCheck(position, null);
  while (room.round.phase === 'play') {
    checkPrivate();
    const g = view();
    assert.equal(g.friend,room.round.friendKnown ? 2 : null);
    for (const seat of [0, ...(room.round.friendKnown ? [2] : [])]) {
      assert.deepEqual(g.captured[seat], []);
      assert.equal(g.scores[seat], null);
    }
    assert.deepEqual(g.trick,room.round.trick);
    const [move] = room.view(room.round.turn).game.choices.plays;
    step(room,{type:'play',...move});
  }
  assert.deepEqual(view().result,room.round.result);
  assert.deepEqual(room.viewFor('queue').reservation,{position:1,seat:1});
});

test('a settlement confirms available seats in order, keeps confirmed seats stable and promotes on the next deal', () => {
  const room = table();
  room.addGuest('one','일'); room.addGuest('two','이');
  room.start();
  for (const id of ['A','B','C','D']) room.addGuest(id,id,'reserve');
  openPlay(room);
  finish(room);
  assert.equal(room.publicSummary().phase,'finished');
  const revision = room.revision;
  for (const [index,id] of ['A','B','C','D'].entries()) {
    assert.deepEqual(room.viewFor(id).reservation,{position:index + 1,seat:[3,4,null,null][index]});
    assert.equal(room.seatFor(id),-1);
  }
  const resultNames = room.viewFor('B').players.map(p => p.name);
  const panelScore = seatStanding(room.viewFor('B').scoreboard,1);
  room.setReservation('A',false);
  assert.deepEqual(room.viewFor('B').reservation,{position:1,seat:4});
  assert.deepEqual(room.viewFor('C').reservation,{position:2,seat:3});
  room.removeGuest('C');
  assert.deepEqual(room.viewFor('D').reservation,{position:2,seat:3});
  assert.equal(room.revision,revision);
  room.removeGuest('one');
  const afterExit = room.viewFor('B');
  assert.deepEqual(afterExit.players.map(p => p.name),resultNames);
  assert.equal(afterExit.scoreboard.panelMemberIds[1],afterExit.players[1].memberId);
  assert.equal(seatStanding(afterExit.scoreboard,1),panelScore);
  room.start();
  assert.equal(room.seatFor('B'),4);
  assert.equal(room.seatFor('D'),3);
  for (const id of ['B','D']) {
    const v = room.viewFor(id);
    assert.equal(v.spectator,false);
    assert.equal(v.game.hand.length,10);
    assert.equal(v.scoreboard.members.find(m => m.seat === v.seat).total,0);
  }
  assert.equal(room.seatFor('A'),-1);
  assert.equal(room.viewFor('A').game.hand.length,0);
  assert.equal(room.publicSummary().roundNumber,2);
});

test('a fresh substitute AI starts at zero after a human has taken a previously scoring bot seat', () => {
  const room = table();
  room.start();
  const priorBot = room.players[1].memberId;
  room.addGuest('next','새 참가자','reserve');
  openPlay(room);
  finish(room);
  room.returnToRoom();
  assert.equal(room.seatFor('next'),1);
  const human = room.players[1].memberId;
  room.start();
  openPlay(room,1);
  room.removeGuest('next');
  const newBot = room.players[1].memberId;
  assert.notEqual(newBot,priorBot);
  assert.notEqual(newBot,human);
  finish(room);
  const ledger = id => room.view(0).scoreboard.members.find(m => m.id === id);
  assert.equal(ledger(priorBot).rounds,1);
  assert.equal(ledger(human).total,settlements(room.round.result,'H')[1]);
  assert.equal(ledger(human).rounds,1);
  assert.equal(ledger(human).lastSeat,1);
  assert.equal(ledger(newBot).rounds,0);
  assert.equal(ledger(newBot).total,0);
  const settled = room.view(0);
  assert.equal(settled.players[1].memberId,human);
  assert.ok(seatStanding(settled.scoreboard,1).includes('<b>' + signedScore(ledger(human).total) + '</b>'));
  room.start();
  assert.equal(room.players[1].memberId,newBot);
  assert.equal(ledger(newBot).total,0);
});

test('private invitation rooms keep their existing admission rules', () => {
  const room = new HostSession('초대방');
  assert.equal(room.publicSummary(),null);
  assert.ok(room.addGuest('watch','이름','watch'));
  assert.ok(room.addGuest('reserve','이름','reserve'));
  assert.equal(room.connections.size,0);
  assert.equal(room.addGuest('player','이름'),null);
  room.start();
  assert.throws(() => room.leaveHostSeat());
  assert.ok(room.addGuest('new','이름','play'));
  assert.throws(() => room.viewFor('new'));
});

test('the public host can run the table from the audience and return through FIFO with the same score', () => {
  const room = table();
  assert.equal(room.hostView().seat,0);
  assert.throws(() => room.leaveHostSeat());
  room.start();
  room.addGuest('first','먼저 예약','reserve');
  openPlay(room);
  const hostId = room.players[0].memberId;
  assert.equal(room.leaveHostSeat(),true);
  const watching = room.hostView();
  assert.equal(room.hostSeat,-1);
  assert.equal(watching.spectator,true);
  assert.deepEqual(watching.game.hand,[]);
  assert.deepEqual(watching.game.discarded,[]);
  assert.equal(room.players[0].bot,true);
  assert.equal(room.botTurn,true);
  assert.equal(room.publicSummary().humanCount,0);
  assert.deepEqual(room.publicSummary().seats,[null,null,null,null,null]);
  assert.equal(room.publicSummary().hostName,'방장');
  assert.equal(room.publicSummary().spectatorCount,2);
  assert.equal(room.connections.has(null),false);
  assert.equal(room.nameFor(null),'방장');
  assert.throws(() => room.leaveHostSeat());
  const turnRevision = room.revision;
  room.setReservation(null,true);
  room.removeGuest(null);
  assert.equal(room.revision,turnRevision);
  assert.deepEqual(room.hostView().reservation,{position:2,seat:null});
  finish(room);
  const pay = settlements(room.round.result,'H')[0];
  const settled = room.hostView();
  assert.equal(settled.scoreboard.members.find(m => m.id === hostId).total,pay);
  assert.equal(settled.scoreboard.members.find(m => m.seat === 0).total,0);
  assert.deepEqual(settled.reservation,{position:2,seat:1});
  assert.throws(() => room.leaveHostSeat());
  room.start();
  assert.equal(room.seatFor('first'),0);
  assert.equal(room.hostSeat,1);
  assert.equal(room.players[1].memberId,hostId);
  assert.equal(room.hostView().spectator,false);
  assert.equal(room.hostView().game.hand.length,10);
  assert.equal(room.hostView().scoreboard.members.find(m => m.seat === 1).total,pay);
  assert.equal(room.publicSummary().spectatorCount,0);
  assert.equal(room.connections.has(null),false);
  // The solo declarer from the previous hand opens from their new seat.
  assert.equal(room.round.turn,1);
  room.act(1,room.revision,{type:'pass'});
});

test('the host can stay in the next waiting room as an observer and reclaim an open seat', () => {
  const room = table();
  room.start();
  openPlay(room);
  room.leaveHostSeat();
  finish(room);
  room.returnToRoom();
  assert.equal(room.publicSummary().phase,'waiting');
  assert.equal(room.publicSummary().hostName,'방장');
  assert.equal(room.hostSeat,-1);
  assert.equal(room.hostView().game,null);
  assert.throws(() => room.moveSeat(null,4,room.revision));
  room.setReservation(null,true);
  assert.equal(room.hostSeat,0);
  assert.equal(room.hostView().seat,0);
  assert.equal(room.hostView().scoreboard.members.find(m => m.seat === 0).rounds,1);
});
