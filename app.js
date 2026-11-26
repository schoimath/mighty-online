import {clearGame, renderGame, rulesContent, updateGamePace, updateSeatBalances} from './game-ui.js';
import {botTurnDelay, normalizeGameSpeed, paceMultiplier} from './table-timing.js';
import {createNextRoundTimer} from './next-round.js';
import {hostRoom, joinRoom, normalizeRoomCode} from './network.js';
import {listPublicRooms, publishPublicRoom, PUBLIC_ROOM_LIMIT} from './public-directory.js';
import {renderPublicTables, renderPublicAudience, visibilityPicker} from './public-room-ui.js';
import {HostSession} from './session.js';
import {chatText, setupChat} from './chat.js';
import {DEFAULT_RULES} from './engine.js';
import {scoreTable, seatStanding} from './score-ui.js';
import {bindModelSettings, modelLabel, modelSettings, modelSummary, readModelSettings} from './model-picker.js';
import {VERSION} from './release.js';
import {rememberRoom, roomModels, roomPreferences} from './room-preferences.js';
import {accountClient} from './account-client.js';
import {setupAccountUI} from './account-ui.js';
import {accountIdValid, callChipService, chipManifest, consentWindow, followChipHand, offeredSeat} from './chip-play.js';

const $ = id => document.getElementById(id);
if ($('release-version')) $('release-version').textContent = 'v' + VERSION;
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons = {
  user:'<circle cx="12" cy="8" r="3.3"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3 19a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.5M18 14a5 5 0 0 1 3 5"/>',
  cards:'<path d="m8 4-3 1a2 2 0 0 0-1.4 2.4l2.2 10a2 2 0 0 0 2.4 1.5"/><rect x="9" y="4" width="11" height="16" rx="2"/><path d="m14.5 9 2 3-2 3-2-3z"/>',
  flag:'<path d="M5 21V4c5-4 9 4 15 0v10c-6 4-10-4-15 0"/>',
  pluscards:'<path d="m8 4-3 1a2 2 0 0 0-1.5 2.4l2.4 11a2 2 0 0 0 2.2 1.5"/><rect x="8" y="3" width="13" height="18" rx="2.4"/><path d="M11.5 12h6m-3-3v6"/>',
  door:'<path d="M12 4h7a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-7M3 12h11m-4-4 4 4-4 4"/>',
  doorplus:'<path d="M6 5h13v14H6zM9 12h7m-3.5-3.5v7"/>',
  key:'<circle cx="8" cy="9" r="4"/><path d="m11 12 7 7 3-3m-5 1 2-2"/>',
  bot:'<rect x="3" y="7" width="18" height="13" rx="4"/><path d="M12 7V4m-4 8h.1M16 12h.1M9 16h6M1 12v3m22-3v3"/><circle cx="12" cy="3" r="1"/>',
  play:'<path d="m8 4 11 8-11 8z"/>', chevron:'<path d="m7 10 5 5 5-5"/>'
};
document.querySelectorAll('[data-icon]').forEach(el => {
  el.innerHTML = '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">' + icons[el.dataset.icon] + '</svg>';
});

let nickname = '플레이어';
try { nickname = localStorage.getItem('mighty-nickname')?.trim().slice(0,16) || nickname; } catch {}
function saveName(name) {
  nickname = name;
  $('profile-name').textContent = name;
  try { localStorage.setItem('mighty-nickname',name); } catch {}
}
saveName(nickname);

let authority = null;
let transport = null;
let snapshot = null;
let mode = 'lobby';
let generation = 0;
let botTimer, botDueAt = null, toastTimer;
let botWorker = null;
let claimWorker = null;
let workerUnavailable = false;
let pendingConnect = null;
let roomCode = '';
let publicListing = null;
let directoryScan = null;
let directoryTimer;
let listedRooms = [];
const chat = setupChat(sendChat);
const roomAccounts = new Map();
const chipRequest = payload => callChipService(accountClient, payload);
let chipReader = null, preparing = null, acceptedOffer = null, resumeHand = null;
let activeRead = null, activeTimer, settlingHand = null;
let leavingGeneration = null;
let pendingPace = null;
let lastAccount = null, settledChipHand = null;
let accountUI;
const nextRound = createNextRoundTimer({
  onStart:key => key === resultKey() ? startRound() : false,
  onError:error => toast(error.message),
  onChange:state => {
    if (!state || state.key !== resultKey()) return;
    if (mode === 'host') {
      for (const id of authority.connections.keys()) {
        transport.send(id, {type:'next-round', nextRound:state, sentAt:Date.now()});
      }
    }
    // Result rendering can start this clock. Finish that render before updating its controls.
    queueMicrotask(() => { if (state.key === resultKey()) draw(); });
  }
});

function resultKey() {
  if (!authority || snapshot?.game?.phase !== 'result' || snapshot.scoreboard?.complete) return null;
  return snapshot.chipHandId || `practice-${generation}-${snapshot.scoreboard.rounds}`;
}

function receivedCountdown(state, handId, sentAt) {
  if (!state || state.key !== handId) return null;
  if (state.status !== 'running') return state;
  if (!Number.isFinite(state.deadline) || !Number.isFinite(sentAt)) return null;
  // A guest's device may use a different clock from the host.
  return {...state, deadline:Date.now() + Math.max(0, state.deadline - sentAt)};
}

function setActiveHand(handId) {
  resumeHand = handId;
  $('active-chip-hand').hidden = !handId;
}

function scheduleActiveLookup() {
  clearTimeout(activeTimer);
  const waitingRoom = (mode === 'host' || mode === 'guest') && (!snapshot?.game || snapshot.game.result);
  if (!resumeHand || document.hidden || (mode !== 'lobby' && !(settlingHand && waitingRoom))) return;
  activeTimer = setTimeout(refreshActiveHand, settlingHand?.delay ?? 20000);
}

function lookupActiveHand() {
  const userId = accountClient.state.user?.id;
  if (!userId) return Promise.resolve(null);
  if (activeRead) return activeRead.promise;
  const read = {};
  activeRead = read;
  const current = () => activeRead === read && accountClient.state.user?.id === userId;
  read.promise = (async () => {
    let {handId} = await chipRequest({op:'active'});
    if (!current()) return null;
    if (handId !== null && !accountIdValid(handId)) throw new Error('진행 중인 판을 확인하지 못했습니다.');
    const waiting = settlingHand;
    if (waiting?.allBots && waiting.handId === handId && !document.hidden) {
      // The server has accepted this player's departure. Advance its AI-only
      // hand in bounded batches even after the room directory entry is gone.
      const data = await chipRequest({op:'view', handId});
      if (!current()) return null;
      if (data.handId === handId && data.game?.result) handId = null;
    }
    setActiveHand(handId);
    if (waiting && waiting.handId !== handId) {
      settlingHand = null;
      accountClient.refreshWallet().catch(error => toast(error.message));
      toast('이전 판의 칩 정산이 끝났습니다.');
    } else if (waiting) waiting.delay = waiting.allBots ? 1200 : 12000;
    return handId;
  })().catch(error => {
    if (current() && settlingHand) settlingHand.delay = Math.min(30000, settlingHand.delay * 2);
    throw error;
  }).finally(() => {
    if (activeRead === read) { activeRead = null; scheduleActiveLookup(); }
  });
  return read.promise;
}

function refreshActiveHand() {
  lookupActiveHand().catch(() => {});
}

function onAccount(state) {
  if (mode === 'practice' && snapshot?.game) updateSeatBalances($('game'), practiceSeatBalances(state));
  if (!state.ready) return;
  const id = state.user?.id ?? null;
  if (id === lastAccount) return;
  clearTimeout(activeTimer);
  activeRead = settlingHand = null;
  setActiveHand(null);
  if ($('modal').open && $('confirm-hand-leave')) closeModal();
  if (lastAccount && ['host','guest','resume'].includes(mode)) stopSession('계정이 바뀌어 테이블에서 나왔습니다.');
  lastAccount = id;
  if (id) saveName(state.user.nickname);
  refreshActiveHand();
}

async function mayPlay() {
  await accountClient.ready;
  if (!accountClient.state.user) {
    accountUI.open('이메일 인증과 로그인 후 칩 대국에 참가할 수 있습니다.');
    return false;
  }
  try {
    const {balance, error} = await accountClient.refreshWallet();
    if (balance > 0) return true;
    if (balance == null && error) { toast(error); return false; }
    toast('참가하려면 잔액이 양수여야 합니다. 잔액이 0 이하이면 한국시간 다음 날 100칩이 됩니다.');
  } catch (error) { toast(error.message); }
  return false;
}

function practiceSeatBalances(state) {
  return snapshot.players.map((_, seat) => seat === snapshot.seat && state.user ? state.balance : null);
}

function serverOnlySnapshot(data) {
  const scoreboard = snapshot?.chipHandId === data.handId && (!data.game.result || snapshot.game?.result)
    ? snapshot.scoreboard : undefined;
  return {chipHandId:data.handId, seat:data.seat, spectator:data.seat < 0, pace:data.pace, scoreboard,
    players:data.names.map((name, i) => ({name, bot:data.bots[i], modelId:data.models[i]})),
    rules:data.game.rules, game:data.game};
}

function trackChipHand(handId, initial = null, hintRevision) {
  if (chipReader?.handId === handId) { chipReader.wake(hintRevision); return; }
  chipReader?.close();
  const watch = !accountClient.state.user || (!authority && mode !== 'resume' && snapshot?.spectator);
  let lastSeatBalance, lastSeenRevision;
  const reader = followChipHand(chipRequest, handId, watch ? 'watch' : 'view', (data, balancesOnly, paceOnly) => {
    if (reader !== chipReader) return;
    const timed = data.lastTimedAction;
    if (lastSeenRevision !== undefined && !data.game.result && data.seat >= 0 &&
        timed?.seat === data.seat && timed.revision > lastSeenRevision) {
      toast('시간이 지나 AI가 이번 차례를 대신했습니다.', 2500);
    }
    lastSeenRevision = data.revision;
    if (!data.game.result && data.seat >= 0 && resumeHand !== handId) {
      activeRead = settlingHand = null;
      setActiveHand(handId);
    }
    if (data.game.result && resumeHand === handId) {
      activeRead = settlingHand = null;
      setActiveHand(null);
    }
    const ownBalance = data.seatBalances?.[data.seat];
    if (!data.game.result && Number.isSafeInteger(ownBalance) && ownBalance !== lastSeatBalance) {
      lastSeatBalance = ownBalance;
      if (accountClient.state.user && accountClient.state.balance !== ownBalance) {
        accountClient.refreshWallet().catch(error => toast(error.message));
      }
    }
    if (balancesOnly || paceOnly) {
      if (snapshot?.chipHandId === handId) {
        updateSeatBalances($('game'), data.seatBalances);
        if (paceOnly) {
          if (mode === 'host' && authority.syncChipHand(data)) {
            broadcastPace(handId, data.pace, data.revision);
          }
          snapshot.pace = data.pace;
          updateGamePace($('game'), data.pace, pendingPace?.reader === reader ? pendingPace.pace : null);
        }
      }
      return;
    }
    if (data.game.result && settledChipHand !== handId) {
      settledChipHand = handId;
      if (accountClient.state.user) accountClient.refreshWallet().catch(error => toast(error.message));
    }
    if (mode === 'resume') {
      snapshot = serverOnlySnapshot(data);
    }
    if (mode === 'host' && authority.syncChipHand(data)) publish();
    else draw();
  }, error => toast(error.message), initial);
  chipReader = reader;
  reader.start();
}

function broadcastPace(handId, pace, revision) {
  for (const id of authority.connections.keys()) {
    transport?.send(id, {type:'table-pace', handId, pace, revision});
  }
}

async function changeGamePace(value) {
  const pace = normalizeGameSpeed(value);
  const reader = chipReader;
  if (pace !== value || preparing || !snapshot?.game || snapshot.scoreboard?.complete) return;
  if (mode === 'practice' || (mode === 'host' && authority.round?.result)) {
    const previous = authority.pace;
    authority.setPace(pace);
    snapshot.pace = pace;
    if (mode === 'practice' && botDueAt !== null) {
      const remaining = Math.max(0, botDueAt - performance.now());
      schedulePracticeBot(remaining * paceMultiplier(pace) / paceMultiplier(previous));
    }
    if (mode === 'host') broadcastPace(snapshot.chipHandId, pace, snapshot.chipRevision);
    rememberRoom({pace});
    updateGamePace($('game'), pace);
    return;
  }
  if (!reader || reader.handId !== snapshot.chipHandId || reader.current?.game.result ||
      pendingPace?.reader === reader || !(mode === 'host' || (mode === 'resume' && reader.current?.publicGame))) return;
  const request = {reader, pace};
  pendingPace = request;
  updateGamePace($('game'), reader.current?.pace, pace);
  try {
    await reader.changePace(pace);
    if (chipReader === reader && reader.current?.pace === pace) rememberRoom({pace});
  } catch (error) {
    if (chipReader === reader) toast(error.message);
  } finally {
    if (pendingPace === request) pendingPace = null;
    if (chipReader === reader) updateGamePace($('game'), (authority?.round?.result ? authority.pace : reader.current?.pace) ?? snapshot?.pace);
  }
}

function broadcastChat(seat, text, senderId = null) {
  const name = authority.nameFor(senderId);
  if (!name || !chatText(text)) return false;
  const message = {id: chat.log.lastId + 1, time: Date.now(), seat, name, text: text.trim()};
  if (!chat.receive(message, senderId === null)) return false;
  for (const id of authority.connections.keys()) {
    transport.send(id, {type:'chat-message', message, own:id === senderId});
  }
  return true;
}
function sendChat(text) {
  if (mode === 'host') return broadcastChat(authority.hostSeat, text);
  return mode === 'guest' && Boolean(transport?.send({type:'chat-send', text}));
}

function toast(message, duration = 4500) {
  clearTimeout(toastTimer);
  $('notice').textContent = message;
  $('notice').hidden = false;
  toastTimer = setTimeout(() => { $('notice').hidden = true; }, duration);
}

function showScreen(screen) {
  for (const name of ['lobby','room','game']) $(name).hidden = screen !== name;
  $('site-header').hidden = $('site-footer').hidden = screen === 'game';
  $('profile-btn').disabled = screen !== 'lobby';
}

function pauseDirectory() {
  clearTimeout(activeTimer);
  clearTimeout(directoryTimer);
  directoryScan?.abort();
  directoryScan = null;
}

async function refreshDirectory() {
  if (mode !== 'lobby' || pendingConnect || document.hidden || directoryScan) return;
  clearTimeout(directoryTimer);
  const controller = new AbortController();
  directoryScan = controller;
  let nextScan = 45000;
  renderPublicTables(listedRooms, {loading:true, capacity:PUBLIC_ROOM_LIMIT});
  try {
    const rooms = await listPublicRooms({signal:controller.signal});
    if (controller.signal.aborted) return;
    listedRooms = rooms;
    renderPublicTables(rooms, {capacity:PUBLIC_ROOM_LIMIT});
  } catch (error) {
    if (!controller.signal.aborted) {
      listedRooms = [];
      renderPublicTables(listedRooms, {error:error.message, capacity:PUBLIC_ROOM_LIMIT});
      nextScan = 15000;
    }
  } finally {
    if (directoryScan === controller) {
      directoryScan = null;
      directoryTimer = setTimeout(refreshDirectory, nextScan);
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(activeTimer); pauseDirectory(); return; }
  if (mode === 'lobby' || settlingHand) refreshActiveHand();
  refreshDirectory();
});
$('public-refresh').onclick = () => { refreshActiveHand(); refreshDirectory(); };
$('public-tables').addEventListener('click', event => {
  const button = event.target.closest('[data-public-code][data-public-intent]');
  if (button) openForm('join', button.dataset.publicCode, button.dataset.publicIntent);
});

function pauseCountdownForDialog() {
  if (!authority || nextRound.state?.status !== 'running') return;
  nextRound.pause();
  const paused = nextRound.state;
  $('modal').addEventListener('close', () => {
    if (nextRound.state === paused && resultKey() === paused.key) nextRound.resume();
  }, {once:true});
}

function modal(title, content) {
  $('modal-content').innerHTML = '<h2 id="modal-title">' + escape(title) + '</h2>' + content;
  if (!$('modal').open) $('modal').showModal();
  pauseCountdownForDialog();
}

function closeModal() {
  pendingConnect?.abort();
  pendingConnect = null;
  $('modal').close();
}
$('close-modal').onclick = closeModal;
$('modal').addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
$('modal').addEventListener('click', event => { if (event.target === $('modal')) closeModal(); });
function activeRules() {
  if (!snapshot) return DEFAULT_RULES;
  // Rooms hosted by the earlier version always start the auction at 13.
  return snapshot.game?.rules ?? snapshot.rules ?? {...DEFAULT_RULES, minBid:13};
}

function rulesSummary(rules) {
  return `<dl class="rules-summary">
    <div><dt>최저 공약</dt><dd data-rule-value="minBid">${escape(rules.minBid)}점</dd></div>
    <div><dt>초구 프렌드 가능</dt><dd data-rule-value="allowFirstFriend">${rules.allowFirstFriend ? '허용' : '미허용'}</dd></div>
    <div><dt>초구 조커콜 효력</dt><dd data-rule-value="allowFirstJokerCall">${rules.allowFirstJokerCall ? '효력 있음' : '효력 없음'}</dd></div>
    <div><dt>막구 조커 효력</dt><dd data-rule-value="allowLastJoker">${rules.allowLastJoker ? '효력 있음' : '효력 없음'}</dd><dd class="rule-detail">마지막 트릭 조커가 기루다를 이김</dd></div>
  </dl>`;
}

function ruleEditor(rules) {
  const options = Array.from({length:8}, (_, i) => i + 13).map(points =>
    `<option value="${points}"${points === rules.minBid ? ' selected' : ''}>${points}점</option>`).join('');
  const toggle = (key, title, detail) => `<label class="rule-row">
    <span><strong>${title}</strong><small>${detail}</small></span>
    <input type="checkbox" role="switch" name="${key}" aria-label="${title}"${rules[key] ? ' checked' : ''}>
  </label>`;
  return `<fieldset class="rule-settings"><legend>테이블 규칙</legend>
    <label class="rule-row"><span><strong>최저 공약</strong><small>경매에서 처음 부를 수 있는 점수</small></span>
      <select name="minBid" aria-label="최저 공약">${options}</select></label>
    ${toggle('allowFirstFriend','초구 프렌드 가능','첫 트릭의 승자를 프렌드로 지정')}
    ${toggle('allowFirstJokerCall','초구 조커콜 효력','첫 트릭부터 조커콜 선언')}
    ${toggle('allowLastJoker','막구 조커 효력','마지막 트릭 조커가 기루다를 이김')}
  </fieldset>`;
}

function readRules(container) {
  return {
    minBid: Number(container.querySelector('[name="minBid"]').value),
    allowFirstFriend: container.querySelector('[name="allowFirstFriend"]').checked,
    allowFirstJokerCall: container.querySelector('[name="allowFirstJokerCall"]').checked,
    allowLastJoker: container.querySelector('[name="allowLastJoker"]').checked
  };
}

function seriesPicker(limit = null) {
  const options = [10, 20, null].map(value =>
    `<label><input type="radio" name="roundLimit" value="${value ?? 0}"${value === limit ? ' checked' : ''}><span>${value ? value + '판' : '무제한'}</span></label>`);
  return `<fieldset class="series-picker"><legend>경기 판수</legend><div>${options.join('')}</div></fieldset>`;
}

function selectedLimit(container) {
  return Number(container.querySelector('[name="roundLimit"]:checked')?.value) || null;
}

function paceSetting(pace, editable = true) {
  const selected = normalizeGameSpeed(pace);
  const labels = {slow:'느리게', normal:'보통', fast:'빠르게'};
  if (!editable) return '<p class="series-summary"><strong>진행 속도</strong> ' + labels[selected] + '</p>';
  const choices = Object.entries(labels).map(([value, label]) =>
    `<label><input type="radio" name="pace" value="${value}"${value === selected ? ' checked' : ''}><span>${label}</span></label>`);
  return '<fieldset class="series-picker pace-picker"><legend>진행 속도</legend><div>' + choices.join('') + '</div></fieldset>';
}

function seriesSummary(board) {
  const limit = board?.roundLimit;
  const target = limit === 10 || limit === 20 ? limit + '판' : '무제한';
  const settled = Number.isSafeInteger(board?.rounds) && board.rounds > 0 ? ' · ' + board.rounds + '판 완료' : '';
  return `<p class="series-summary"><strong>경기 판수</strong> ${target}${settled}</p>`;
}

function showRules() {
  const rules = activeRules();
  const board = snapshot?.scoreboard;
  const scoringVersion = snapshot ? board?.scoringVersion ?? (board ? 'contract-flat-v1' : 'ten-base-v1') : undefined;
  modal('게임 규칙', '<div class="rules-wrap">' + rulesSummary(rules) + modelSummary(snapshot) + rulesContent(rules, scoringVersion) + '</div>');
}
$('nav-rules').onclick = showRules;

function stopSession(message) {
  generation++;
  nextRound.sync(null);
  preparing?.consent.close();
  preparing = acceptedOffer = null;
  $('room').inert = $('game').inert = false;
  chipReader?.close();
  chipReader = null;
  pendingPace = null;
  roomAccounts.clear();
  publicListing?.close();
  publicListing = null;
  clearTimeout(botTimer);
  botDueAt = null;
  botWorker?.terminate();
  botWorker = null;
  claimWorker?.terminate();
  claimWorker = null;
  workerUnavailable = false;
  const oldTransport = transport;
  transport = null;
  oldTransport?.close();
  authority = snapshot = null;
  roomCode = '';
  mode = 'lobby';
  chat.reset();
  if ($('modal').open) closeModal();
  $('room').replaceChildren();
  clearGame($('game'));
  const url = new URL(location.href);
  if (url.searchParams.has('room')) {
    url.searchParams.delete('room');
    history.replaceState(null,'',url);
  }
  showScreen('lobby');
  // The last scan predates the entire visit. In particular our former host
  // may just have closed; only show tables confirmed by a fresh scan.
  listedRooms = [];
  renderPublicTables(listedRooms, {loading:true, capacity:PUBLIC_ROOM_LIMIT});
  refreshDirectory();
  refreshActiveHand();
  window.scrollTo(0,0);
  if (message) toast(message);
}

async function handOverToAI(handId, finishIfAlone) {
  const data = await chipRequest({op:'leave', handId, ...(finishIfAlone ? {finishIfAlone:true} : {})});
  if (data.handId !== handId || !data.game || (!data.game.result && data.seat !== -1)) {
    throw new Error('서버에서 퇴장을 확인하지 못했습니다. 다시 시도해 주세요.');
  }
  return data;
}

function rememberDeparture(data, finishIfAlone) {
  activeRead = null;
  if (data.game.result) {
    settlingHand = null;
    setActiveHand(null);
    accountClient.refreshWallet().catch(error => toast(error.message));
  } else {
    setActiveHand(data.handId);
    const allBots = finishIfAlone && data.bots?.length === 5 && data.bots.every(Boolean);
    settlingHand = {handId:data.handId, allBots, delay:allBots ? 1200 : 12000};
  }
  scheduleActiveLookup();
}

function confirmPreviousHandLeave(handId, inRoom = false) {
  const userId = accountClient.state.user?.id, token = generation;
  modal('이전 칩 대국을 AI에게 맡길까요?', '<p>AI가 남은 패를 대신 치고, 이 판의 칩은 내 계정에 정산됩니다. 다른 플레이어가 남아 있으면 그 판이 끝난 뒤 새 칩 대국을 시작할 수 있습니다.' +
    (inRoom ? ' 지금 있는 방은 그대로 유지됩니다.' : '') +
    '</p><p class="form-error" role="alert" id="hand-leave-error"></p><div class="room-actions"><button class="plain-button" id="keep-hand">취소</button><button class="primary-button" id="confirm-hand-leave">이전 판을 AI에게 맡기기</button></div>');
  $('keep-hand').onclick = closeModal;
  $('confirm-hand-leave').onclick = async event => {
    const button = event.currentTarget;
    if (!$('modal').open || !button.isConnected || token !== generation || accountClient.state.user?.id !== userId) return;
    if (resumeHand !== handId) {
      closeModal(); toast('이전 판이 이미 종료되었습니다.'); return;
    }
    button.disabled = true;
    $('hand-leave-error').textContent = '';
    try {
      const data = await handOverToAI(handId, true);
      if (generation !== token || accountClient.state.user?.id !== userId) return;
      rememberDeparture(data, true);
      if (button.isConnected && $('modal').open) closeModal();
      toast(data.game.result ? '이전 판의 칩 정산이 끝났습니다.' : 'AI가 이전 판을 마저 진행합니다. 정산이 끝나면 새 판에 참가할 수 있습니다.');
    } catch (error) {
      if (button.isConnected && $('modal').open && accountClient.state.user?.id === userId) $('hand-leave-error').textContent = error.message;
    } finally { button.disabled = false; }
  };
}

function handleChipError(error) {
  if (error.code !== 'active_hand') { toast(error.message); return; }
  const token = generation, userId = accountClient.state.user?.id;
  lookupActiveHand().then(handId => {
    if (token !== generation || accountClient.state.user?.id !== userId) return;
    if (handId) confirmPreviousHandLeave(handId, true);
    else toast('이전 판이 정산되었습니다. 다시 시작해 주세요.');
  }).catch(error => { if (token === generation) toast(error.message); });
}

function requestLeave() {
  if (mode === 'lobby' || preparing || leavingGeneration === generation) return;
  const canWatch = mode === 'host' && snapshot.publicRoom && !snapshot.spectator &&
    snapshot.game && snapshot.game.phase !== 'result';
  const handId = snapshot?.chipHandId, token = generation;
  const playing = handId && snapshot.game?.phase !== 'result';
  const leavingOwnHand = playing && (!snapshot.spectator || resumeHand === snapshot.chipHandId);
  let reason = '이 방에서 나갑니다.';
  if (mode === 'host') {
    reason = playing ? '대기실과 채팅은 닫히고, 남은 참가자는 이 판을 계속합니다.' : '방을 닫고 로비로 돌아갑니다.';
  } else if (mode === 'practice') reason = '현재 연습 게임이 종료됩니다.';
  else if (snapshot?.spectator) reason = '관전을 끝냅니다. 신청한 자리 예약도 취소됩니다.';
  if (playing && !snapshot.spectator) reason += ' AI가 내 패를 마저 치고, 이 판의 칩은 내 계정에 정산됩니다.';
  const stepAside = canWatch ? '<button class="primary-button" id="host-watch">AI에게 맡기고 관전</button>' : '';
  modal('로비로 나갈까요?', '<p>' + reason + (canWatch ? ' 방을 유지하려면 AI에게 자리를 맡기고 이 탭에서 관전하세요.' : '') +
    '</p><p class="form-error" role="alert" id="quit-error"></p><div class="room-actions"><button class="plain-button" id="stay">계속하기</button>' + stepAside +
    '<button class="' + (canWatch ? 'plain-button' : 'primary-button') + '" id="quit">' + (mode === 'host' ? '방 닫기' : '나가기') + '</button></div>');
  $('stay').onclick = closeModal;
  const buttons = $('quit').parentElement.querySelectorAll('button');
  const errorLine = $('quit-error');
  async function leave(watch) {
    if (generation !== token || leavingGeneration === token || !$('modal').open || !errorLine.isConnected) return;
    leavingGeneration = token;
    buttons.forEach(button => { button.disabled = true; });
    errorLine.textContent = '';
    try {
      if (leavingOwnHand) {
        const otherSpectators = (snapshot.spectators?.length ?? 0) > (snapshot.spectator ? 1 : 0);
        const finishIfAlone = !watch && !otherSpectators;
        const data = await handOverToAI(handId, finishIfAlone);
        if (generation !== token) return;
        if (!watch) rememberDeparture(data, finishIfAlone);
      }
      if (watch) {
        authority.leaveHostSeat(); closeModal(); clearGame($('game')); publish();
      } else stopSession();
    } catch (error) {
      if (generation !== token) return;
      if ($('modal').open && errorLine.isConnected) errorLine.textContent = error.message;
      else toast(error.message);
    } finally {
      if (leavingGeneration === token) leavingGeneration = null;
      buttons.forEach(button => { button.disabled = false; });
    }
  }
  $('quit').onclick = () => leave(false);
  if (canWatch) $('host-watch').onclick = () => leave(true);
}
$('nav-lobby').onclick = requestLeave;
document.querySelector('.brand').addEventListener('click', event => {
  event.preventDefault();
  if (mode !== 'lobby') requestLeave();
});

function roomLink() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room',roomCode);
  return url.href;
}
async function copyInvite() {
  try { await navigator.clipboard.writeText(roomLink()); toast('초대 링크를 복사했어요. 친구에게 보내 주세요.'); }
  catch {
    modal('초대 링크','<p>링크를 복사해서 친구에게 보내 주세요.</p><label class="field">초대 주소<input readonly id="invite-url"></label>');
    $('invite-url').value = roomLink();
    $('invite-url').select();
  }
}
function applySeatChoice(session, id, choice) {
  switch (choice.kind) {
    case 'move': return session.moveSeat(id, choice.target, choice.revision);
    case 'request': return session.requestSeatSwap(id, choice.target, choice.revision);
    case 'accept': return session.answerSeatSwap(id, true, choice.revision);
    case 'decline': return session.answerSeatSwap(id, false, choice.revision);
    case 'cancel': return session.cancelSeatSwap(id, choice.revision);
    default: throw new Error('자리 선택을 다시 확인해 주세요.');
  }
}
function sendSeatChoice(kind, target) {
  if (!snapshot || snapshot.game || !Number.isInteger(snapshot.hostSeat)) return;
  const choice = {type:'seat-choice', kind, revision:snapshot.revision};
  if (target !== undefined) choice.target = target;
  if (mode === 'host') {
    try { if (applySeatChoice(authority, null, choice)) publish(); }
    catch (error) { toast(error.message); }
  } else if (mode === 'guest' && !transport?.send(choice)) {
    toast('방장과의 연결을 확인해 주세요.');
  }
}
function requestSeat(target) {
  sendSeatChoice(snapshot.players[target] ? 'request' : 'move', target);
}
function answerSwap(accept) {
  sendSeatChoice(accept ? 'accept' : 'decline');
}
function cancelSwap() {
  sendSeatChoice('cancel');
}
function drawRoom() {
  const host = mode === 'host';
  const occupied = snapshot.players.filter(Boolean).length;
  const room = $('room');
  const board = snapshot.scoreboard;
  const canSetLimit = host && !board?.rounds;
  const focus = room.contains(document.activeElement) ? document.activeElement : null;
  const modelDetailsOpen = room.querySelector('.model-details')?.open;
  const standingsOpen = room.querySelector('details.match-standings')?.open;
  const focusSeat = focus?.closest('[data-room-seat]')?.dataset.roomSeat;
  const canChoose = !snapshot.spectator && Number.isInteger(snapshot.hostSeat);
  const hostSeat = snapshot.hostSeat ?? 0;
  const swap = snapshot.swap;
  const seats = snapshot.players.map((player, index) => {
    const mine = index === snapshot.seat;
    const isHostSeat = index === hostSeat;
    const roles = [isHostSeat && '방장', mine && '나'].filter(Boolean).join(' · ');
    const number = (index + 1) + '번 자리';
    const canMove = canChoose && !mine && (!player || !swap);
    const standing = player ? seatStanding(snapshot.scoreboard, index) : '';
    const contents = `<span class="seat-caption"><span class="seat-number">${number}</span>
      ${roles ? '<span class="seat-tag">' + roles + '</span>' : ''}</span>
      <span class="seat-identity"><strong class="seat-name"${player ? ' title="' + escape(player.name) + '"' : ''}>${player ? escape(player.name) : '빈자리'}</strong>${standing ? '<span id="room-total-' + index + '">' + standing + '</span>' : ''}</span>
      ${canMove ? '<span class="seat-action">' + (player ? '교환 요청' : '여기 앉기') + '</span>' : ''}`;
    const description = player ? number + ' ' + player.name + (isHostSeat ? ' 방장' : '') + '에게 자리 교환 요청' : number + ' 빈자리로 이동';
    return `<li data-room-seat="${index}" class="${mine ? 'seat-mine' : player ? 'seat-occupied' : 'seat-open'}"${mine ? ' aria-current="true" tabindex="-1"' : ''}>
      ${canMove ? '<button type="button" class="seat-place" data-choose-seat="' + index + '" aria-label="' + escape(description) + '"' + (standing ? ' aria-describedby="room-total-' + index + '"' : '') + '>' + contents + '</button>'
        : '<div class="seat-place">' + contents + '</div>'}</li>`;
  }).join('');
  let swapPanel = '';
  if (swap) {
    const incoming = swap.to === snapshot.seat;
    const other = incoming ? swap.from : swap.to;
    const who = (other + 1) + '번 ' + escape(snapshot.players[other].name) + '님';
    const message = incoming ? who + '이 자리 교환을 요청했습니다.' : who + '에게 자리 교환을 요청했습니다.';
    const actions = incoming
      ? '<button type="button" class="primary-button" id="swap-accept">수락</button><button type="button" class="plain-button" id="swap-decline">거절</button>'
      : '<button type="button" class="plain-button" id="swap-cancel">요청 취소</button>';
    swapPanel = '<div id="seat-swap"><p role="status">' + message + '</p><div class="swap-actions">' + actions + '</div></div>';
  }
  $('room').innerHTML = '<section class="room-panel"><h1>' + (snapshot.publicRoom ? '공개 게임 대기실' : '게임 대기실') + '</h1><p>' +
    (snapshot.publicRoom ? '로비의 공개 테이블 목록에서 참가하거나 관전할 수 있습니다.' : '친구에게 방 코드나 초대 링크를 보내 주세요.') + '</p>' +
    '<div class="room-code-section"><span>방 코드</span><strong class="room-code">' + escape(roomCode) + '</strong><button id="copy-invite" class="plain-button">초대 링크 복사</button></div>' +
    '<div class="seat-heading"><h2>' + (canChoose ? '자리 선택' : '참가자') + '</h2><span>참가 ' + occupied + ' / 5</span></div>' +
    (canChoose ? '<p class="seat-hint">자리 번호 순으로 진행합니다. 빈자리에 앉거나 다른 참가자에게 교환을 요청하세요.</p>' : '') +
    '<ol class="seat-list ' + (canChoose ? 'seat-map' : 'seat-readonly') + '" aria-label="자리 번호 순서">' + seats + '</ol>' + swapPanel +
    (canSetLimit ? seriesPicker(board?.roundLimit) : seriesSummary(board)) + paceSetting(snapshot.pace, host) +
    (host ? modelSettings(snapshot.botModels, hostSeat, snapshot.players) : modelSummary(snapshot)) +
    (host ? ruleEditor(activeRules()) : '<h2 class="room-heading">테이블 규칙</h2>' + rulesSummary(activeRules())) +
    '<section class="public-audience" hidden></section><p>' + (host ? (occupied < 5 ? '지금 시작하면 빈자리 ' + (5-occupied) + '곳은 AI가 맡습니다.' : '다섯 명이 모였습니다. 게임을 시작하세요.') : snapshot.spectator ? '방장이 게임을 시작하면 보드에서 관전할 수 있습니다.' : '방장이 게임을 시작하면 카드를 받습니다.') +
    '</p><div class="room-actions">' + (host ? '<button class="primary-button" id="start-round">게임 시작</button>' : '') +
    '<button class="plain-button" id="room-leave">나가기</button></div>' +
    scoreTable(snapshot.scoreboard, snapshot.seat, {collapsed:!snapshot.scoreboard?.rounds}) + '</section>';
  if (standingsOpen && room.querySelector('details.match-standings')) room.querySelector('details.match-standings').open = true;
  $('copy-invite').onclick = copyInvite;
  $('room-leave').onclick = requestLeave;
  room.querySelectorAll('[data-choose-seat]').forEach(button => {
    button.onclick = () => requestSeat(Number(button.dataset.chooseSeat));
  });
  if ($('swap-accept')) {
    $('swap-accept').onclick = () => answerSwap(true);
    $('swap-decline').onclick = () => answerSwap(false);
  }
  if ($('swap-cancel')) $('swap-cancel').onclick = cancelSwap;
  if (host) {
    $('start-round').onclick = startRound;
    const series = room.querySelector('[name="roundLimit"]')?.closest('fieldset');
    if (series) {
      series.onchange = () => {
        const roundLimit = selectedLimit(series);
        authority.setRoundLimit(roundLimit);
        rememberRoom({roundLimit});
        publish();
      };
      if (focus?.name === 'roundLimit') series.querySelector('input:checked')?.focus({preventScroll:true});
    }
    const pacePicker = room.querySelector('.pace-picker');
    pacePicker.onchange = event => {
      authority.setPace(event.target.value);
      rememberRoom({pace:authority.pace});
      publish();
    };
    if (focus?.name === 'pace') pacePicker.querySelector('input:checked')?.focus({preventScroll:true});
    room.querySelector('.model-details').open = Boolean(modelDetailsOpen);
    bindModelSettings(room, hostSeat, (models, changedSeat) => {
      authority.setBotModels(models);
      if (changedSeat === null) {
        rememberRoom({models});
      } else {
        const overrides = roomPreferences().models;
        overrides[changedSeat] = models[changedSeat];
        rememberRoom({models:overrides});
      }
      publish();
    });
    const settings = $('room').querySelector('.rule-settings');
    settings.onchange = () => {
      authority.setRules(readRules(settings));
      rememberRoom({rules:authority.rules});
      publish();
    };
    if (focus?.name) settings.elements.namedItem(focus.name)?.focus({preventScroll:true});
  }
  chat.attach($('room').querySelector('.room-actions'));
  drawAudience();
  const oldControl = focus?.id ? $(focus.id) : null;
  if (focusSeat != null || focus?.id.startsWith('swap-')) {
    const button = focusSeat == null ? null : room.querySelector('[data-choose-seat="' + focusSeat + '"]');
    const next = oldControl || button || $('swap-cancel') || room.querySelector('.seat-mine');
    next?.focus({preventScroll:true});
  } else oldControl?.focus({preventScroll:true});
  if ($('modal').open && $('modal-content').querySelector('.rules-wrap')) showRules();
}

function drawAudience() {
  if (!snapshot) return;
  const node = $(snapshot.game ? 'game' : 'room').querySelector('.public-audience');
  if (mode === 'resume') { if (node) node.hidden = true; return; }
  if (node) renderPublicAudience(node, snapshot, {
    onReserve:() => changeReservation(true), onCancel:() => changeReservation(false)
  });
}

async function changeReservation(wanted) {
  if (!snapshot?.spectator) return;
  if (wanted && !await mayPlay()) return;
  if (mode === 'host') {
    try { applyReservation(authority, null, wanted); }
    catch (error) { toast(error.message); }
  } else if (!transport?.send({type:'reservation', wanted, accountId:accountClient.state.user?.id})) toast('방장과의 연결을 확인해 주세요.');
}

function applyReservation(session, id, wanted) {
  const revision = session.revision;
  if (!session.setReservation(id, wanted)) return;
  if (revision === session.revision) publishAudience();
  else publish();
}

function draw() {
  if (!snapshot) return;
  if (!snapshot.game) { clearGame($('game')); showScreen('room'); drawRoom(); return; }
  showScreen('game');
  const remote = chipReader?.handId === snapshot.chipHandId ? chipReader?.current : null;
  renderGame($('game'),remote?.game ?? snapshot.game,{
    names:remote?.names ?? snapshot.players.map(p => p?.name), isHost: Boolean(authority), scoreboard:snapshot.scoreboard,
    seatBalances:mode === 'practice' ? practiceSeatBalances(accountClient.state) : remote?.seatBalances,
    chipDelta:remote?.myDelta, resumed:mode === 'resume',
    turnDeadline:remote ? chipReader.localTurnDeadline : null,
    pace:remote?.game.result && mode !== 'resume' ? snapshot.pace : remote?.pace ?? snapshot.pace,
    pendingPace:pendingPace && pendingPace.reader === chipReader ? pendingPace.pace : null,
    onPaceChange:!snapshot.scoreboard?.complete && (mode === 'practice' || (mode === 'host' && remote) ||
      (mode === 'resume' && remote?.publicGame && !remote.game.result)) ? changeGamePace : undefined,
    modelLabels:remote ? remote.models.map((id,i) => remote.bots[i] ? modelLabel(id) : '') :
      snapshot.players.map(p => p?.bot && p.modelId ? modelLabel(p.modelId) : ''),
    replaySetupLabel: mode === 'practice' ? (snapshot.scoreboard?.complete ? '새 연습 경기 설정' : '규칙·AI 바꿔서 시작') : '대기실로 돌아가기',
    nextRound:authority ? nextRound.state : snapshot.nextRound,
    onResultShown() {
      const key = resultKey();
      if (key) {
        nextRound.sync(key);
        if ($('modal').open) pauseCountdownForDialog();
      }
    },
    onToggleNextRound() {
      if (!resultKey()) return;
      if (nextRound.state?.status === 'paused') nextRound.resume();
      else nextRound.pause();
    },
    onRules:showRules, onLeave:requestLeave, onReplay() {
      const key = resultKey();
      if (!key) return;
      nextRound.sync(key);
      nextRound.startNow();
    },
    onReplaySetup() {
      if (authority?.round?.phase !== 'result') return;
      if (mode === 'practice') openPracticeSetup();
      else if (mode === 'host') { authority.returnToRoom(); publish(); }
      window.scrollTo(0,0);
    },
    onAction(action) {
      if (snapshot.spectator) return false;
      if (snapshot.chipHandId) {
        if (!remote || remote.seat < 0) return false;
        const hand = chipReader;
        const receipt = hand.act(action).then(accepted => {
          if (hand !== chipReader) return false;
          if (mode === 'guest' && (action.type !== 'play' || accepted)) {
            transport?.send({type:'chip-wake',handId:hand.handId,revision:hand.current?.revision});
          }
          return accepted;
        }).catch(error => {
          if (hand === chipReader) toast(error.message);
          return false;
        });
        if (action.type === 'play') return receipt;
        void receipt.then(() => { if (hand === chipReader) draw(); });
        return true;
      }
      if (mode === 'practice' && authority) {
        try { submitTurn(authority, authority.hostSeat, snapshot.revision, action); return true; }
        catch (error) { toast(error.message); return false; }
      }
      return false;
    }
  });
  if (mode === 'host' || mode === 'guest') chat.attach($('game').querySelector('.g-nav-actions'));
  accountUI.attach($('game').querySelector('.g-nav-actions'));
  drawAudience();
}

// Roster updates must not restart a bid clock or unlock a play awaiting confirmation.
function publishAudience(joinedId) {
  const nextDeal = expectedChipTable();
  for (const id of authority.connections.keys()) {
    const view = authority.viewFor(id);
    const packet = id === joinedId ? {type:'state', view:{...view,chipHost:roomAccounts.get(null),nextDeal,nextRound:nextRound.state},sentAt:Date.now()} :
      {type:'audience', spectators:view.spectators, reservation:view.reservation,nextDeal};
    transport.send(id, packet);
  }
  snapshot = authority.hostView();
  drawAudience();
}

function expectedChipTable() {
  if (mode !== 'host' || (authority.round && authority.round.phase !== 'result') || authority.hostView().scoreboard.complete) return null;
  const {seats, firstSeat} = authority.plannedTable();
  return {firstSeat, seats:seats.map(p => ({name:p.name, bot:Boolean(p.bot)}))};
}

function schedulePracticeBot(delay) {
  clearTimeout(botTimer);
  botDueAt = performance.now() + delay;
  botTimer = setTimeout(() => { botDueAt = null; takeBotTurn(); }, delay);
}

function publish() {
  clearTimeout(botTimer);
  botDueAt = null;
  if (authority.round?.phase !== 'result') nextRound.sync(null);
  const nextDeal = expectedChipTable();
  for (const id of authority.connections.keys()) {
    transport?.send(id,{type:'state',view:{...authority.viewFor(id),chipHost:roomAccounts.get(null),nextDeal,nextRound:nextRound.state},sentAt:Date.now()});
  }
  snapshot = authority.hostView();
  draw();
  if (mode === 'practice' && authority.botTurn) {
    schedulePracticeBot(botTurnDelay(snapshot.game, authority.pace));
  }
}

function submitTurn(session, seat, revision, action) {
  const position = session.act(seat, revision, action);
  publish();
  if (position) verifyClaim(session, position);
}

function verifyClaim(session, position) {
  let worker;
  const releaseWorker = () => {
    worker?.terminate();
    if (claimWorker === worker) claimWorker = null;
  };
  const failed = () => {
    if (session !== authority || !session.abandonClaim(position)) return;
    releaseWorker();
    const message = '세팅 판정을 완료하지 못했습니다. 점수는 그대로이며 다시 선언하거나 카드를 낼 수 있습니다.';
    toast(message);
    for (const [id, seat] of session.connections) {
      if (seat === position.declarer) transport?.send(id, {type:'error', message});
    }
    publish();
  };
  const finish = verdict => {
    if (session !== authority) return;
    try {
      if (!session.finishClaim(position, verdict)) return;
    } catch {
      failed();
      return;
    }
    releaseWorker();
    publish();
  };
  const retryLocally = async () => {
    releaseWorker();
    try {
      const {analyzeSetting} = await import('./table-claim.js');
      if (session === authority) finish(analyzeSetting(position));
    } catch {
      failed();
    }
  };
  try {
    worker = new Worker(new URL(`./claim-worker.js?v=${VERSION}`, import.meta.url), {type:'module'});
    claimWorker = worker;
    worker.onmessage = event => finish(event.data);
    worker.onerror = event => { event.preventDefault(); retryLocally(); };
    worker.onmessageerror = retryLocally;
    worker.postMessage({position});
  } catch {
    retryLocally();
  }
}

function takeBotTurn() {
  const session = authority;
  if (!session?.botTurn) return;
  const claim = session.tryBotClaim();
  if (claim) {
    publish();
    verifyClaim(session, claim);
    return;
  }
  const revision = session.revision;
  // Each decision has its own random stream, including when the worker must retry locally.
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  function finish(action, memory) {
    // The room can change while the worker is thinking, for example when a guest leaves.
    if (authority !== session || session.revision !== revision || !session.botTurn) return;
    session.runBot(action, seed, memory);
    publish();
  }
  if (workerUnavailable) {
    finish();
    return;
  }
  function fallback(event) {
    if (authority !== session || (event && event.currentTarget !== botWorker)) return;
    event?.preventDefault();
    botWorker?.terminate();
    botWorker = null;
    workerUnavailable = true;
    finish();
  }
  try {
    const request = session.botRequest(seed);
    botWorker ??= new Worker(new URL(`./bot-worker.js?v=${VERSION}`, import.meta.url), {type:'module'});
    botWorker.onmessage = event => {
      const {data} = event;
      if (data?.revision !== revision) return;
      // Older cached workers compute every turn using the original search model.
      if (data.modelId !== request.modelId || ('memory' in request && data.memory == null)) { fallback(event); return; }
      finish(data.action, data.memory);
    };
    botWorker.onerror = fallback;
    botWorker.onmessageerror = fallback;
    botWorker.postMessage(request);
  } catch {
    fallback();
  }
}
async function startRound() {
  if (mode === 'practice') {
    authority.start();
    publish();
    window.scrollTo(0,0);
    return true;
  }
  if (mode !== 'host' || preparing) return false;
  const table = authority;
  let pending;
  try {
    const plan = table.plannedTable();
    const spec = chipManifest(plan, roomCode, roomAccounts.get(null), roomAccounts);
    const guestSeats = plan.seats.filter(p => !p.bot && p.id != null);
    const consent = consentWindow(guestSeats.map(p => p.id), spec.handId);
    pending = preparing = {consent, spec, departed:new Set(), denied:new Set()};
    $('room').inert = $('game').inert = true;
    // Guest departures and seat edits are applied after the server confirms
    // the deal, so the roster cannot change halfway through its commit.
    const revision = table.revision;
    guestSeats.forEach(p => transport.send(p.id,{type:'chip-offer',spec}));
    toast('참가자 계정과 칩 잔액을 확인하는 중입니다.');
    await Promise.all([consent.ready, chipRequest({...spec, op:'ready'}).catch(error => {
      if (error.code === 'insufficient_chips') pending.denied.add(null);
      throw error;
    })]);
    if (preparing !== pending || table.revision !== revision) throw new Error('자리가 바뀌었습니다. 다시 시작해 주세요.');
    let initial;
    try { initial = await chipRequest({...spec, op:'start'}); }
    catch (error) {
      // A lost response can follow a successful database commit. Recover the
      // same ID; a new deal must never replace a hand already charged.
      initial = await chipRequest({op:'view', handId:spec.handId}).catch(() => null);
      if (!initial) throw error;
    }
    if (preparing !== pending) return;
    table.startChipHand(initial);
    trackChipHand(spec.handId, initial);
    publish();
    window.scrollTo(0,0);
    return true;
  } catch (error) {
    if (table === authority) handleChipError(error);
    return false;
  } finally {
    if (pending && preparing === pending) {
      preparing = null;
      $('room').inert = $('game').inert = false;
      pending.consent.close();
      pending.denied.forEach(id => table.sitOut(id));
      pending.departed.forEach(id => { table.removeGuest(id); roomAccounts.delete(id); });
      if (pending.denied.size || pending.departed.size) publish();
    }
  }
}

function openPracticeSetup() {
  const replay = mode === 'practice' && authority?.round?.phase === 'result';
  const board = replay ? snapshot.scoreboard : null;
  const canSetLimit = !replay || board.complete;
  modal('연습 게임 설정', '<form id="practice-setup">' +
    (canSetLimit ? seriesPicker(board?.roundLimit) : seriesSummary(board)) +
    paceSetting(replay ? authority.pace : roomPreferences().pace) + modelSettings(replay ? authority.botModels : undefined) +
    ruleEditor(replay ? activeRules() : DEFAULT_RULES) +
    '<button type="submit" class="primary-button form-submit" id="start-practice">연습 시작</button></form>');
  bindModelSettings($('practice-setup'));
  $('practice-setup').onsubmit = event => {
    event.preventDefault();
    const rules = readRules(event.currentTarget);
    const models = readModelSettings(event.currentTarget);
    const pace = normalizeGameSpeed(event.currentTarget.elements.pace.value);
    rememberRoom({pace});
    if (replay) {
      authority.returnToRoom();
      authority.setPace(pace);
      if (canSetLimit) authority.setRoundLimit(selectedLimit(event.currentTarget));
      authority.setRules(rules);
      authority.setBotModels(models);
    } else {
      pauseDirectory();
      mode = 'practice';
      authority = new HostSession(nickname, rules, models, selectedLimit(event.currentTarget), {pace});
    }
    closeModal();
    startRound();
  };
}

async function connectRoom(kind, name, code, signal, {roundLimit, publicRoom, intent}) {
  const token = ++generation;
  const active = () => token === generation && !signal.aborted;
  let link;
  pauseDirectory();
  if (kind === 'create') {
    const preferences = roomPreferences();
    const session = new HostSession(name, preferences.rules, roomModels(preferences.models), roundLimit, {publicRoom, pace:preferences.pace});
    link = await hostRoom({
      signal,
      onJoin(id, guestName, guestIntent, accountId) {
        if (!active() || authority !== session) return '테이블을 준비하고 있습니다. 잠시 후 다시 시도해 주세요.';
        if (preparing) return '새 판의 배패를 준비하고 있습니다. 잠시 후 입장해 주세요.';
        if (guestIntent !== 'watch' && !accountIdValid(accountId)) return '새로고침하고 인증된 게임 계정으로 입장해 주세요.';
        if (guestIntent !== 'watch' && [...roomAccounts.values()].includes(accountId)) return '이미 이 계정이 테이블에 있습니다.';
        // Earlier clients can take a seat but cannot display an observer projection.
        if (publicRoom && guestIntent === undefined && (session.round || session.players.every(Boolean))) {
          return '로비를 새로고침한 뒤 관전하거나 다음 판을 예약해 주세요.';
        }
        const revision = session.revision;
        const reason = session.addGuest(id,guestName,guestIntent);
        if (reason) return reason;
        if (accountIdValid(accountId)) roomAccounts.set(id,accountId);
        if (session.revision === revision) publishAudience(id);
        else publish();
        transport.send(id, {type:'chat-history', messages:chat.log.messages});
        return true;
      },
      onMessage(id, packet) {
        if (!active() || !packet || !session.connections.has(id)) return;
        const seat = session.seatFor(id);
        if (packet.type === 'chip-answer') {
          if (preparing?.spec.handId === packet.handId) {
            const error = new Error((session.nameFor(id) || '참가자') + '님의 참가 확인을 마치지 못했습니다.');
            if (preparing.consent.answer(id,packet.accepted === true,error) && packet.reason === 'insufficient_chips') preparing.denied.add(id);
          }
          return;
        }
        if (packet.type === 'chip-wake') { if (packet.handId === session.chipHandId) chipReader?.wake(packet.revision); return; }
        if (packet.type === 'chat-send') {
          broadcastChat(seat, packet.text, id);
          return;
        }
        try {
          if (preparing) throw new Error('배패를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.');
          if (packet.type === 'reservation') {
            if (packet.wanted) {
              if (!accountIdValid(packet.accountId)) throw new Error('먼저 인증된 계정으로 로그인해 주세요.');
              if ([...roomAccounts].some(([other, uid]) => other !== id && uid === packet.accountId &&
                  (other === null ? session.hostSeat : session.seatFor(other)) >= 0)) {
                throw new Error('이 계정은 이미 착석했습니다.');
              }
              roomAccounts.set(id, packet.accountId);
            }
            applyReservation(session, id, packet.wanted);
          } else if (seat < 0) return;
          else if (packet.type === 'seat-choice') {
            if (applySeatChoice(session, id, packet)) publish();
          }
        } catch (error) {
          transport.send(id,{type:'error',message:error.message});
        }
      },
      onLeave(id) {
        if (!active()) return;
        if (preparing) {
          preparing.departed.add(id);
          preparing.consent.answer(id,false,new Error('참가자 연결이 종료되었습니다. 다시 시작해 주세요.'));
          return;
        }
        roomAccounts.delete(id);
        const seat = session.seatFor(id);
        const name = session.nameFor(id);
        const revision = session.revision;
        session.removeGuest(id);
        if (name && seat >= 0) toast(name + '님이 나갔습니다.' + (session.round && !session.round.result ? ' AI가 이어서 플레이합니다.' : ''));
        if (revision === session.revision) publishAudience();
        else publish();
      },
      onError(error) { if (active()) toast(error.message); }
    });
    if (!active()) { link.close(); return; }
    if (publicRoom) {
      let listing;
      try {
        listing = await publishPublicRoom({signal, getSummary:() => ({...session.publicSummary(), code:link.code}),
          onError:error => { if (active()) toast(error.message); }});
      } catch (error) { link.close(); throw error; }
      if (!active()) { listing.close(); link.close(); return; }
      publicListing = listing;
    }
    mode = 'host';
    authority = session;
    roomAccounts.set(null, accountClient.state.user.id);
    rememberRoom({roundLimit});
  } else {
    mode = 'joining';
    link = await joinRoom(code,name,{
      signal, intent, accountId:accountClient.state.user?.id,
      onMessage(packet) {
        if (!active()) return;
        if (packet?.type === 'table-pace' && snapshot?.chipHandId === packet.handId &&
            normalizeGameSpeed(packet.pace) === packet.pace) {
          snapshot.pace = packet.pace;
          if (snapshot.game?.result) updateGamePace($('game'), packet.pace);
          else chipReader?.wake(packet.revision);
          return;
        }
        if (packet?.type === 'next-round' && snapshot?.game?.phase === 'result' &&
            packet.nextRound?.key === snapshot.chipHandId) {
          snapshot.nextRound = receivedCountdown(packet.nextRound, snapshot.chipHandId, packet.sentAt);
          if (mode === 'guest') draw();
          return;
        }
        if (packet?.type === 'chat-message') { chat.receive(packet.message, packet.own === true); return; }
        if (packet?.type === 'chat-history') { chat.restore(packet.messages); return; }
        if (packet?.type === 'chip-offer' && mode === 'guest') {
          approveChipOffer(packet.spec, token);
          return;
        }
        if (packet?.type === 'audience' && snapshot) {
          snapshot.spectators = packet.spectators;
          snapshot.reservation = packet.reservation;
          snapshot.nextDeal = packet.nextDeal;
          if (mode === 'guest') drawAudience();
          return;
        }
        if (packet?.type === 'error') { toast(packet.message); if (mode === 'guest') draw(); return; }
        if (packet?.type === 'state') {
          snapshot = packet.view;
          snapshot.nextRound = receivedCountdown(snapshot.nextRound, snapshot.chipHandId, packet.sentAt);
          if (!snapshot.chipHost && intent !== 'watch') {
            stopSession('이 방은 이전 버전입니다. 새 버전의 방에서 칩 대국에 참가해 주세요.');
            return;
          }
          if (snapshot.chipHandId) trackChipHand(snapshot.chipHandId, null, snapshot.chipRevision);
          else if (chipReader) { chipReader.close(); chipReader = null; }
          if (mode === 'guest') draw();
        }
      },
      onClose(reason) {
        if (!active()) return;
        if (mode === 'guest' && snapshot?.chipHandId && snapshot.game && chipReader?.handId === snapshot.chipHandId) {
          // The room channel has closed. The same authenticated reader still owns the live seat.
          mode = 'resume';
          transport = null;
          acceptedOffer = null;
          chat.reset();
          snapshot.nextRound = null;
          snapshot.nextDeal = null;
          if (chipReader.current) snapshot = serverOnlySnapshot(chipReader.current);
          chipReader.wake();
          draw();
          toast('방장과의 연결이 종료되었습니다. 현재 판은 게임 서버에서 계속 진행됩니다.');
          return;
        }
        stopSession(reason);
      },
      onError(error) { if (active()) toast(error.message); }
    });
    if (!active()) { link.close(); return; }
    mode = 'guest';
  }
  roomCode = link.code;
  transport = link;
  pendingConnect = null;
  $('modal').close();
  if (authority) publish();
  else if (snapshot) draw();
  else { showScreen('room'); $('room').textContent = '참가자 정보를 받고 있습니다…'; }
  window.scrollTo(0,0);
}

async function openForm(kind, code = '', publicIntent = null) {
  if (kind !== 'profile' && publicIntent !== 'watch' && !await mayPlay()) return;
  const profile = kind === 'profile';
  const joining = kind === 'join';
  const publicTitles = {play:'공개 테이블 참가', watch:'테이블 관전', reserve:'다음 판 예약'};
  const title = profile ? '닉네임 변경' : publicTitles[publicIntent] ?? (joining ? '방 참가하기' : '방 만들기');
  const intro = profile ? '' : '<p>' + (publicIntent ? '테이블 ' + escape(code) +
    (publicIntent === 'reserve' ? '에서 관전하며 다음 자리를 기다립니다.' : '에 입장할 닉네임을 확인하세요.') :
    joining ? '친구에게 받은 6자리 방 코드를 입력하세요.' : '게임 중에는 테이블을 운영하는 방장 탭을 열어 두세요.') + '</p>';
  modal(title, intro + '<form id="setup-form"><label class="field">닉네임<input id="name-field" name="nickname" maxlength="16" required autocomplete="nickname"></label>' +
    (publicIntent ? '<input type="hidden" id="code-field">' : joining ? '<label class="field">방 코드<input class="code-field" id="code-field" name="code" maxlength="12" placeholder="6자리 코드" required autocomplete="off" spellcheck="false"></label>' : '') +
    (kind === 'create' ? visibilityPicker() + seriesPicker(roomPreferences().roundLimit) : '') +
    '<div class="form-error" role="alert" id="form-error"></div><button class="primary-button form-submit" id="submit-form">' + (profile ? '저장' : title) + '</button></form>');
  $('name-field').value = nickname;
  if (accountClient.state.user) $('name-field').readOnly = true;
  if (joining) { $('code-field').value = code; (code ? $('name-field') : $('code-field')).focus(); }
  else { $('name-field').focus(); $('name-field').select(); }
  $('setup-form').onsubmit = async event => {
    event.preventDefault();
    if (pendingConnect) return;
    const name = $('name-field').value.trim();
    const code = normalizeRoomCode($('code-field')?.value);
    if (!name || name.length > 16) { $('form-error').textContent = '닉네임은 1~16자로 입력해 주세요.'; return; }
    if (joining && !/^[A-Z0-9]{6}$/.test(code)) { $('form-error').textContent = '영문과 숫자로 된 6자리 방 코드를 입력해 주세요.'; return; }
    saveName(name);
    if (profile) { closeModal(); return; }
    const controller = new AbortController();
    pendingConnect = controller;
    const submit = $('submit-form');
    submit.disabled = true;
    submit.textContent = '연결 중…';
    $('form-error').textContent = '';
    try {
      const form = event.currentTarget;
      await connectRoom(kind,name,code,controller.signal,{roundLimit:selectedLimit(form),
        publicRoom:form.elements.visibility?.value === 'public', intent:publicIntent ?? 'play'});
    }
    catch (error) {
      if (controller.signal.aborted) return;
      $('form-error').textContent = error.message;
    } finally {
      if (pendingConnect === controller) pendingConnect = null;
      if (mode === 'joining' && !transport) mode = 'lobby';
      if (mode === 'lobby') refreshDirectory();
      submit.disabled = false;
      submit.textContent = title;
    }
  };
}

$('create-btn').onclick = () => openForm('create');
$('join-btn').onclick = () => openForm('join');
$('practice-btn').onclick = openPracticeSetup;
accountUI = setupAccountUI(accountClient, {onChange:onAccount});
$('profile-btn').onclick = () => accountUI.open();
$('leave-chip-hand').onclick = () => {
  if (resumeHand && mode === 'lobby') confirmPreviousHandLeave(resumeHand);
};
$('resume-chip-hand').onclick = async () => {
  if (!resumeHand || mode !== 'lobby') return;
  const handId = resumeHand, userId = accountClient.state.user?.id, token = generation;
  try {
    const data = await chipRequest({op:'view',handId});
    if (mode !== 'lobby' || generation !== token || accountClient.state.user?.id !== userId || data.handId !== handId) return;
    clearTimeout(activeTimer);
    activeRead = settlingHand = null;
    mode = 'resume';
    pauseDirectory();
    trackChipHand(data.handId, data);
  } catch (error) {
    if (mode === 'lobby' && generation === token && accountClient.state.user?.id === userId) {
      toast(error.message); refreshActiveHand();
    }
  }
};

async function approveChipOffer(spec, token) {
  if (!spec || offeredSeat(snapshot, spec, roomCode, accountClient.state.user?.id) < 0) return;
  if (acceptedOffer) return;
  acceptedOffer = spec.handId;
  let accepted = false, reason;
  try {
    await chipRequest({...spec, op:'ready'});
    accepted = true;
  } catch (error) {
    reason = error.code;
    if (generation === token) handleChipError(error);
  }
  if (generation !== token || acceptedOffer !== spec.handId) return;
  acceptedOffer = null;
  if (offeredSeat(snapshot, spec, roomCode, accountClient.state.user?.id) < 0) accepted = false;
  transport?.send({type:'chip-answer',handId:spec.handId,accepted,reason});
}
const tips = [
  ['마이티 카드','스페이드 A는 모든 카드를 이기는 마이티예요. 스페이드가 기루다일 때는 다이아몬드 A가 마이티가 됩니다.'],
  ['숨은 프렌드','주공이 부른 카드를 가진 사람이 프렌드예요. 그 카드가 테이블에 나오면 모두에게 정체가 공개됩니다.'],
  ['점수 카드','각 무늬의 10, J, Q, K, A는 한 장에 1점이에요. 총 20점 중 주공 팀이 공약한 점수를 모으면 승리합니다.']
];
let tipIndex = 0;
function turnTip(delta) {
  tipIndex = (tipIndex + delta + tips.length) % tips.length;
  $('tip-title').textContent = tips[tipIndex][0];
  $('tip-text').textContent = tips[tipIndex][1];
  $('tip-index').textContent = (tipIndex+1) + ' / ' + tips.length;
}
$('prev-tip').onclick = () => turnTip(-1);
$('next-tip').onclick = () => turnTip(1);
const invitation = new URL(location.href).searchParams.get('room');
if (invitation) openForm('join',normalizeRoomCode(invitation));
refreshDirectory();
