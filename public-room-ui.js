const entities = {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'};
const escape = value => String(value).replace(/[&<>"']/g, ch => entities[ch]);

const suits = [
  {name:'스페이드', mark:'♠'}, {name:'하트', mark:'♥', red:true},
  {name:'다이아', mark:'♦', red:true}, {name:'클로버', mark:'♣'}
];

export function publicTableName(slot) {
  const suit = suits[slot - 1];
  return suit ? suit.name + ' 테이블' : '공개 테이블';
}

function roomRow(suit, slot, room, loading) {
  const code = 'PUB00' + slot, name = publicTableName(slot);
  const phase = room?.phase, empty = phase === 'empty', waiting = phase === 'waiting';
  const active = ['waiting', 'playing', 'finished'].includes(phase);
  const state = {empty:'빈 테이블', waiting:'대기 중', playing:'게임 중', finished:'판 종료', settling:'정산 중'}[phase] ||
    (loading ? '확인 중' : '확인 불가');
  const stateClass = phase === 'playing' ? 'is-playing' : !active ? 'is-idle' : '';
  const join = (intent, text) => `<button type="button" class="${intent === 'watch' ? 'public-watch' : 'public-join'}" data-public-code="${code}" data-public-slot="${slot}" data-public-intent="${intent}"${empty ? ' data-public-empty' : ''} aria-label="${name} ${text}">${text}</button>`;
  let meta = '';
  let counts = '';
  let actions = '';
  if (active) {
    const series = room.roundLimit ? escape(room.roundLimit) + '판 경기' : '무제한 경기';
    const progress = !waiting && room.roundNumber > 0 ? escape(room.roundNumber) + '번째 판 · ' + series : series;
    meta = '<span>방장 ' + escape(room.hostName) + '</span><span>' + progress + '</span>';
    counts = `<strong>참가 ${escape(room.humanCount)} / 5</strong><span>관전 ${escape(room.spectatorCount)}명${room.reservationCount ? ' · 예약 ' + escape(room.reservationCount) + '명' : ''}</span>`;
    const canJoin = waiting && room.humanCount < 5;
    actions = join('watch', '관전하기') + (canJoin ? join('play', '참가하기') : join('reserve', waiting ? '자리 예약' : '다음 판 예약'));
  } else if (empty) {
    meta = '<span>첫 참가자가 방장이 됩니다.</span>';
    counts = '<strong>참가 0 / 5</strong>';
    actions = join('play', '입장하기');
  } else if (phase === 'settling') {
    meta = '<span>이전 판 정산이 끝나면 입장할 수 있습니다.</span>';
  }
  return `<li class="public-table-row">
    <div class="public-table-details"><span aria-hidden="true" class="public-suit${suit.red ? ' red' : ''}">${suit.mark}</span>
      <div><div class="public-table-title"><h3>${name}</h3><span class="public-phase ${stateClass}">${state}</span></div>
      ${meta ? '<div class="public-table-meta">' + meta + '</div>' : ''}</div></div>
    <div class="public-counts">${counts}</div><div class="public-row-actions">${actions}</div></li>`;
}

const listMarkup = new WeakMap();

export function renderPublicTables(rooms, {loading = false, error = ''} = {}) {
  const list = document.getElementById('public-list');
  const counter = document.getElementById('public-count');
  const status = document.getElementById('public-status');
  const refresh = document.getElementById('public-refresh');
  const slots = new Map(rooms.filter(room => room.code === 'PUB00' + room.slot).map(room => [room.slot, room]));
  counter.hidden = slots.size !== suits.length;
  counter.textContent = '사용 중 ' + [...slots.values()].filter(r => r.phase !== 'empty').length + ' / ' + suits.length;
  refresh.disabled = loading;
  const message = error ? (error.message || String(error)) : loading && !slots.size ? '테이블 상태를 확인하고 있습니다…' : '';
  if (status.textContent !== message) status.textContent = message;
  status.hidden = !message;
  list.hidden = false;
  const html = suits.map((suit, i) => roomRow(suit, i + 1, slots.get(i + 1), loading)).join('');
  if (listMarkup.get(list) === html) return;
  const active = list.contains(document.activeElement) ? document.activeElement.dataset : null;
  list.innerHTML = html;
  listMarkup.set(list, html);
  if (active?.publicCode) {
    const next = [...list.querySelectorAll('button')].find(button => button.dataset.publicCode === active.publicCode &&
      button.dataset.publicIntent === active.publicIntent);
    (next || refresh).focus({preventScroll:true});
  }
}

function reservationLabel(reservation) {
  if (Number.isInteger(reservation?.seat) && reservation.seat >= 0) return '다음 판 ' + (reservation.seat + 1) + '번 자리';
  return reservation?.position ? '예약 ' + reservation.position + '순위' : '';
}

const audienceMarkup = new WeakMap();

export function renderPublicAudience(node, snapshot, {onReserve, onCancel} = {}) {
  if (!node) return;
  node.hidden = !snapshot.publicRoom && !snapshot.spectator && !snapshot.spectators?.length;
  if (node.hidden) return;
  node.classList.add('public-audience');
  node.setAttribute('aria-label', '관전자와 자리 예약');
  const {spectators = [], reservation, spectator} = snapshot;
  const hasVacancy = !snapshot.game && snapshot.players.some(player => !player);
  const prompt = reservation ? reservationLabel(reservation) :
    hasVacancy ? '빈자리에 바로 앉을 수 있습니다.' : '자리가 나면 예약 순서대로 참가합니다.';
  const action = reservation ? '예약 취소' : hasVacancy ? '빈자리 참가' : snapshot.game ? '다음 판 예약' : '자리 예약';
  const roster = spectators.map(person => {
    const queue = reservationLabel(person);
    return '<li><bdi>' + escape(person.name) + '</bdi>' + (queue ? '<small>' + escape(queue) + '</small>' : '') + '</li>';
  }).join('');
  const html = `<div class="audience-heading"><h2>관전자 <span>${spectators.length}명</span></h2></div>
    ${roster ? '<ul class="audience-roster" aria-label="관전자 명단">' + roster + '</ul>' : ''}
    ${spectator ? `<div class="audience-seat"><p role="status">${escape(prompt)}</p>
      <button type="button" class="${reservation ? 'public-watch' : 'public-join'}" data-public-seat="${reservation ? 'cancel' : 'reserve'}">${action}</button></div>` : ''}`;
  if (audienceMarkup.get(node) !== html) {
    const focused = node.contains(document.activeElement);
    node.innerHTML = html;
    audienceMarkup.set(node, html);
    if (focused) node.querySelector('button')?.focus({preventScroll:true});
  }
  const button = node.querySelector('[data-public-seat]');
  if (button) button.onclick = reservation ? onCancel : onReserve;
}
