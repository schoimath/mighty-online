import {clearGame, renderGame, rulesContent} from './game-ui.js';
import {AUCTION_BEAT_MS, FRIEND_ANNOUNCEMENT_MS} from './table-timing.js';
import {hostRoom, joinRoom, normalizeRoomCode} from './network.js';
import {HostSession} from './session.js';
import {chatText, setupChat} from './chat.js';
import {DEFAULT_RULES} from './engine.js';
import {scoreTable, seatStanding} from './score-ui.js';
import {bindModelSettings, modelLabel, modelSettings, modelSummary, readModelSettings} from './model-picker.js';
import {VERSION} from './release.js';
import {rememberRoom, roomModels, roomPreferences} from './room-preferences.js';

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
let botTimer, toastTimer;
let botWorker = null;
let claimWorker = null;
let workerUnavailable = false;
let pendingConnect = null;
let roomCode = '';
const chat = setupChat(sendChat);

function broadcastChat(seat, text) {
  const player = authority?.players[seat];
  if (!player || player.bot || !chatText(text)) return false;
  const message = {id: chat.log.lastId + 1, time: Date.now(), seat, name: player.name, text: text.trim()};
  if (!chat.receive(message, seat === authority.hostSeat)) return false;
  for (const [id, guestSeat] of authority.connections) {
    transport.send(id, {type:'chat-message', message, own:guestSeat === seat});
  }
  return true;
}
function sendChat(text) {
  if (mode === 'host') return broadcastChat(authority.hostSeat, text);
  return mode === 'guest' && Boolean(transport?.send({type:'chat-send', text}));
}

function toast(message) {
  clearTimeout(toastTimer);
  $('notice').textContent = message;
  $('notice').hidden = false;
  toastTimer = setTimeout(() => { $('notice').hidden = true; }, 4500);
}

function showScreen(screen) {
  for (const name of ['lobby','room','game']) $(name).hidden = screen !== name;
  $('site-header').hidden = $('site-footer').hidden = screen === 'game';
  $('profile-btn').disabled = screen !== 'lobby';
}

function modal(title, content) {
  $('modal-content').innerHTML = '<h2 id="modal-title">' + escape(title) + '</h2>' + content;
  if (!$('modal').open) $('modal').showModal();
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
  clearTimeout(botTimer);
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
  window.scrollTo(0,0);
  if (message) toast(message);
}

function requestLeave() {
  if (mode === 'lobby') return;
  const reason = mode === 'host' ? '방장이 나가면 이 방이 닫히고 모든 참가자의 연결이 끝납니다.' :
    mode === 'practice' ? '현재 연습 게임이 종료됩니다.' : '플레이 중에 나가면 AI가 이 자리를 이어서 진행합니다.';
  modal('로비로 나갈까요?', '<p>' + reason + '</p><div class="room-actions"><button class="plain-button" id="stay">계속하기</button><button class="primary-button" id="quit">나가기</button></div>');
  $('stay').onclick = closeModal;
  $('quit').onclick = () => stopSession();
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
  const canChoose = Number.isInteger(snapshot.hostSeat);
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
  $('room').innerHTML = '<section class="room-panel"><h1>게임 대기실</h1><p>친구에게 방 코드나 초대 링크를 보내 주세요.</p>' +
    '<div class="room-code-section"><span>방 코드</span><strong class="room-code">' + escape(roomCode) + '</strong><button id="copy-invite" class="plain-button">초대 링크 복사</button></div>' +
    '<div class="seat-heading"><h2>' + (canChoose ? '자리 선택' : '참가자') + '</h2><span>참가 ' + occupied + ' / 5</span></div>' +
    (canChoose ? '<p class="seat-hint">자리 번호 순으로 진행합니다. 빈자리에 앉거나 다른 참가자에게 교환을 요청하세요.</p>' : '') +
    '<ol class="seat-list ' + (canChoose ? 'seat-map' : 'seat-readonly') + '" aria-label="자리 번호 순서">' + seats + '</ol>' + swapPanel +
    (canSetLimit ? seriesPicker(board?.roundLimit) : seriesSummary(board)) +
    (host ? modelSettings(snapshot.botModels, hostSeat, snapshot.players) : modelSummary(snapshot)) +
    (host ? ruleEditor(activeRules()) : '<h2 class="room-heading">테이블 규칙</h2>' + rulesSummary(activeRules())) +
    '<p>' + (host ? (occupied < 5 ? '지금 시작하면 빈자리 ' + (5-occupied) + '곳은 AI가 맡습니다.' : '다섯 명이 모였습니다. 게임을 시작하세요.') : '방장이 게임을 시작하면 카드를 받습니다.') +
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
    const series = room.querySelector('.series-picker');
    if (series) {
      series.onchange = () => {
        const roundLimit = selectedLimit(series);
        authority.setRoundLimit(roundLimit);
        rememberRoom({roundLimit});
        publish();
      };
      if (focus?.name === 'roundLimit') series.querySelector('input:checked')?.focus({preventScroll:true});
    }
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
  const oldControl = focus?.id ? $(focus.id) : null;
  if (focusSeat != null || focus?.id.startsWith('swap-')) {
    const button = focusSeat == null ? null : room.querySelector('[data-choose-seat="' + focusSeat + '"]');
    const next = oldControl || button || $('swap-cancel') || room.querySelector('.seat-mine');
    next?.focus({preventScroll:true});
  } else oldControl?.focus({preventScroll:true});
  if ($('modal').open && $('modal-content').querySelector('.rules-wrap')) showRules();
}

function draw() {
  if (!snapshot) return;
  if (!snapshot.game) { clearGame($('game')); showScreen('room'); drawRoom(); return; }
  showScreen('game');
  renderGame($('game'),snapshot.game,{
    names:snapshot.players.map(p => p?.name), isHost: Boolean(authority), scoreboard:snapshot.scoreboard,
    modelLabels:snapshot.players.map(p => p?.bot && p.modelId ? modelLabel(p.modelId) : ''),
    replaySetupLabel: mode === 'practice' ? (snapshot.scoreboard?.complete ? '새 연습 경기 설정' : '규칙·AI 바꿔서 시작') : '대기실로 돌아가기',
    onRules:showRules, onLeave:requestLeave, onReplay() {
      if (authority?.round?.phase === 'result' && !snapshot.scoreboard?.complete) startRound();
    },
    onReplaySetup() {
      if (authority?.round?.phase !== 'result') return;
      if (mode === 'practice') openPracticeSetup();
      else if (mode === 'host') { authority.returnToRoom(); publish(); }
      window.scrollTo(0,0);
    },
    onAction(action) {
      if (authority) {
        try { submitTurn(authority, authority.hostSeat, snapshot.revision, action); return true; }
        catch (error) { toast(error.message); return false; }
      }
      if (transport?.send({type:'action',revision:snapshot.revision,action})) return true;
      toast('방장과의 연결을 확인해 주세요.');
      return false;
    }
  });
  if (mode === 'host' || mode === 'guest') chat.attach($('game').querySelector('.g-nav-actions'));
}

function publish() {
  clearTimeout(botTimer);
  for (const [id, seat] of authority.connections) {
    transport?.send(id,{type:'state',view:authority.view(seat)});
  }
  snapshot = authority.view(authority.hostSeat);
  draw();
  if (authority.botTurn) {
    const game = snapshot.game;
    let pause = 560;
    if (game.phase === 'bid') pause = game.bidHistory.length ? AUCTION_BEAT_MS : 1800 + (game.dealNo > 1 ? AUCTION_BEAT_MS : 0);
    else if (game.phase === 'discard') pause += AUCTION_BEAT_MS;
    else if (game.phase === 'play' && game.trickNo === 1 && !game.trick.length) pause = FRIEND_ANNOUNCEMENT_MS;
    else if (game.phase === 'play' && game.lastTrick && !game.trick.length) pause = 1050;
    botTimer = setTimeout(takeBotTurn,pause);
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
function startRound() {
  authority.start();
  publish();
  window.scrollTo(0,0);
}

function openPracticeSetup() {
  const replay = mode === 'practice' && authority?.round?.phase === 'result';
  const board = replay ? snapshot.scoreboard : null;
  const canSetLimit = !replay || board.complete;
  modal('연습 게임 설정', '<form id="practice-setup">' +
    (canSetLimit ? seriesPicker(board?.roundLimit) : seriesSummary(board)) + modelSettings(replay ? authority.botModels : undefined) +
    ruleEditor(replay ? activeRules() : DEFAULT_RULES) +
    '<button type="submit" class="primary-button form-submit" id="start-practice">연습 시작</button></form>');
  bindModelSettings($('practice-setup'));
  $('practice-setup').onsubmit = event => {
    event.preventDefault();
    const rules = readRules(event.currentTarget);
    const models = readModelSettings(event.currentTarget);
    if (replay) {
      authority.returnToRoom();
      if (canSetLimit) authority.setRoundLimit(selectedLimit(event.currentTarget));
      authority.setRules(rules);
      authority.setBotModels(models);
    } else {
      mode = 'practice';
      authority = new HostSession(nickname, rules, models, selectedLimit(event.currentTarget));
    }
    closeModal();
    startRound();
  };
}

async function connectRoom(kind, name, code, signal, roundLimit) {
  const token = ++generation;
  const active = () => token === generation && !signal.aborted;
  let link;
  if (kind === 'create') {
    const preferences = roomPreferences();
    const session = new HostSession(name, preferences.rules, roomModels(preferences.models), roundLimit);
    link = await hostRoom({
      signal,
      onJoin(id, guestName) {
        if (!active()) return '이미 닫힌 방입니다.';
        const reason = session.addGuest(id,guestName);
        if (reason) return reason;
        publish();
        transport.send(id, {type:'chat-history', messages:chat.log.messages});
        return true;
      },
      onMessage(id, packet) {
        if (!active() || !packet) return;
        const seat = session.seatFor(id);
        if (seat < 0) return;
        if (packet.type === 'chat-send') {
          broadcastChat(seat, packet.text);
          return;
        }
        try {
          if (packet.type === 'seat-choice') {
            if (applySeatChoice(session, id, packet)) publish();
          } else if (packet.type === 'action') {
            submitTurn(session, seat, packet.revision, packet.action);
          }
        } catch (error) {
          transport.send(id,{type:'error',message:error.message});
        }
      },
      onLeave(id) {
        if (!active()) return;
        const name = session.players[session.seatFor(id)]?.name;
        session.removeGuest(id);
        if (name) toast(name + '님이 나갔습니다.' + (session.round ? ' AI가 이어서 플레이합니다.' : ''));
        publish();
      },
      onError(error) { if (active()) toast(error.message); }
    });
    if (!active()) { link.close(); return; }
    mode = 'host';
    authority = session;
    rememberRoom({roundLimit});
  } else {
    mode = 'joining';
    link = await joinRoom(code,name,{
      signal,
      onMessage(packet) {
        if (!active()) return;
        if (packet?.type === 'chat-message') { chat.receive(packet.message, packet.own === true); return; }
        if (packet?.type === 'chat-history') { chat.restore(packet.messages); return; }
        if (packet?.type === 'error') { toast(packet.message); if (mode === 'guest') draw(); return; }
        if (packet?.type === 'state') {
          snapshot = packet.view;
          if (mode === 'guest') draw();
        }
      },
      onClose(reason) { if (active()) stopSession(reason); },
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

function openForm(kind, code = '') {
  const profile = kind === 'profile';
  const joining = kind === 'join';
  const title = profile ? '닉네임 변경' : joining ? '방 참가하기' : '방 만들기';
  const intro = profile ? '' : '<p>' + (joining ? '친구에게 받은 6자리 방 코드를 입력하세요.' : '테이블을 열면 친구를 초대할 방 코드가 생깁니다. 게임 중에는 방장 탭을 열어 두세요.') + '</p>';
  modal(title, intro + '<form id="setup-form"><label class="field">닉네임<input id="name-field" name="nickname" maxlength="16" required autocomplete="nickname"></label>' +
    (joining ? '<label class="field">방 코드<input class="code-field" id="code-field" name="code" maxlength="12" placeholder="6자리 코드" required autocomplete="off" spellcheck="false"></label>' : '') +
    (kind === 'create' ? seriesPicker(roomPreferences().roundLimit) : '') +
    '<div class="form-error" role="alert" id="form-error"></div><button class="primary-button form-submit" id="submit-form">' + (profile ? '저장' : title) + '</button></form>');
  $('name-field').value = nickname;
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
    try { await connectRoom(kind,name,code,controller.signal,selectedLimit(event.currentTarget)); }
    catch (error) {
      if (controller.signal.aborted) return;
      $('form-error').textContent = error.message;
    } finally {
      if (pendingConnect === controller) pendingConnect = null;
      if (mode === 'joining' && !transport) mode = 'lobby';
      submit.disabled = false;
      submit.textContent = title;
    }
  };
}

$('create-btn').onclick = () => openForm('create');
$('join-btn').onclick = () => openForm('join');
$('practice-btn').onclick = openPracticeSetup;
$('profile-btn').onclick = () => openForm('profile');
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
