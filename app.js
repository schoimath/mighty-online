import {clearGame, renderGame, rulesContent} from './game-ui.js';
import {hostRoom, joinRoom, normalizeRoomCode} from './network.js';
import {HostSession} from './session.js';
import {chatText, setupChat} from './chat.js';

const $ = id => document.getElementById(id);
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
let pendingConnect = null;
let roomCode = '';
const chat = setupChat(sendChat);

function broadcastChat(seat, text) {
  const player = authority?.players[seat];
  if (!player || player.bot || !chatText(text)) return false;
  const message = {id: chat.log.lastId + 1, time: Date.now(), seat, name: player.name, text: text.trim()};
  if (!chat.receive(message, seat === 0)) return false;
  for (const [id, guestSeat] of authority.connections) {
    transport.send(id, {type:'chat-message', message, own:guestSeat === seat});
  }
  return true;
}
function sendChat(text) {
  if (mode === 'host') return broadcastChat(0, text);
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
function showRules() { modal('게임 규칙','<div class="rules-wrap">' + rulesContent() + '</div>'); }
$('nav-rules').onclick = showRules;

function stopSession(message) {
  generation++;
  clearTimeout(botTimer);
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
function drawRoom() {
  const host = mode === 'host';
  const occupied = snapshot.players.filter(Boolean).length;
  $('room').innerHTML = '<section class="room-panel"><h1>게임 대기실</h1><p>친구에게 방 코드나 초대 링크를 보내 주세요.</p>' +
    '<div class="room-code-section"><span>방 코드</span><strong class="room-code">' + escape(roomCode) + '</strong><button id="copy-invite" class="plain-button">초대 링크 복사</button></div>' +
    '<h2 class="room-heading">참가자 ' + occupied + ' / 5</h2><ol class="seat-list">' +
    snapshot.players.map((p,i) => '<li><span class="seat-icon" aria-hidden="true">' + ['♠','♥','♣','♦','♠'][i] + '</span><strong>' + escape(p?.name ?? '빈자리') + '</strong><span class="seat-tag">' +
      [p && i === 0 ? '방장' : '',p && i === snapshot.seat ? '나' : '',!p ? '참가 대기' : ''].filter(Boolean).join(' · ') + '</span></li>').join('') +
    '</ol><p>' + (host ? (occupied < 5 ? '지금 시작하면 빈자리 ' + (5-occupied) + '곳은 AI가 맡습니다.' : '다섯 명이 모였습니다. 게임을 시작하세요.') : '방장이 게임을 시작하면 카드를 받습니다.') +
    '</p><div class="room-actions">' + (host ? '<button class="primary-button" id="start-round">게임 시작</button>' : '') +
    '<button class="plain-button" id="room-leave">나가기</button></div></section>';
  $('copy-invite').onclick = copyInvite;
  $('room-leave').onclick = requestLeave;
  if (host) $('start-round').onclick = startRound;
  chat.attach($('room').querySelector('.room-actions'));
}

function draw() {
  if (!snapshot) return;
  if (!snapshot.game) { clearGame($('game')); showScreen('room'); drawRoom(); return; }
  showScreen('game');
  renderGame($('game'),snapshot.game,{
    names:snapshot.players.map(p => p?.name), isHost: Boolean(authority),
    replayLabel: mode === 'practice' ? '다시 한 판' : '대기실로 돌아가기',
    onRules:showRules, onLeave:requestLeave, onReplay() {
      if (mode === 'practice') startRound();
      else if (mode === 'host') { authority.returnToRoom(); publish(); }
      window.scrollTo(0,0);
    },
    onAction(action) {
      if (authority) {
        try { authority.act(0,snapshot.revision,action); publish(); return true; }
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
  snapshot = authority.view(0);
  draw();
  if (authority.botTurn) {
    const pause = snapshot.game.phase === 'play' && snapshot.game.lastTrick && !snapshot.game.trick.length ? 1050 : 560;
    botTimer = setTimeout(() => { authority.runBot(); publish(); },pause);
  }
}
function startRound() {
  authority.start();
  publish();
  window.scrollTo(0,0);
}

function startPractice() {
  mode = 'practice';
  authority = new HostSession(nickname);
  startRound();
}

async function connectRoom(kind, name, code, signal) {
  const token = ++generation;
  const active = () => token === generation && !signal.aborted;
  let link;
  if (kind === 'create') {
    const session = new HostSession(name);
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
        if (packet.type !== 'action') return;
        try { session.act(seat,packet.revision,packet.action); publish(); }
        catch (error) { transport.send(id,{type:'error',message:error.message}); }
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
    try { await connectRoom(kind,name,code,controller.signal); }
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
$('practice-btn').onclick = startPractice;
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
