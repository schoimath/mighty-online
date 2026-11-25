const entities = {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'};
const escape = value => String(value).replace(/[&<>"']/g, ch => entities[ch]);

export function visibilityPicker(isPublic = false) {
  return `<fieldset class="series-picker public-visibility"><legend>공개 범위</legend>
    <div><label><input type="radio" name="visibility" value="private"${isPublic ? '' : ' checked'}><span>초대 전용</span></label>
    <label><input type="radio" name="visibility" value="public"${isPublic ? ' checked' : ''}><span>공개 테이블</span></label></div>
    <small>공개 테이블은 로비에 표시되며 누구나 참가하거나 관전할 수 있습니다.</small></fieldset>`;
}

function roomRow(room) {
  const {phase, humanCount, roundNumber, roundLimit} = room;
  const code = escape(room.code), name = escape(room.hostName);
  const waiting = phase === 'waiting';
  const state = waiting ? '대기 중' : phase === 'playing' ? '게임 중' : '판 종료';
  const series = roundLimit ? roundLimit + '판 경기' : '무제한 경기';
  const progress = !waiting && roundNumber > 0 ? roundNumber + '번째 판 · ' + series : series;
  const canJoin = waiting && humanCount < 5;
  const intent = canJoin ? 'play' : 'reserve';
  const action = canJoin ? '참가하기' : waiting ? '자리 예약' : '다음 판 예약';
  return `<li class="public-table-row">
    <div class="public-table-details"><div class="public-table-title"><span class="public-phase${phase === 'playing' ? ' is-playing' : ''}">${state}</span>
      <h3>${name}님의 테이블</h3></div>
      <div class="public-table-meta"><span>${escape(progress)}</span><span>방 코드 <bdi>${code}</bdi></span></div>
    </div>
    <div class="public-counts"><strong>참가 ${escape(humanCount)} / 5</strong>
      <span>관전 ${escape(room.spectatorCount)}명${room.reservationCount ? ' · 예약 ' + escape(room.reservationCount) + '명' : ''}</span></div>
    <div class="public-row-actions">
      <button type="button" class="public-watch" data-public-code="${code}" data-public-intent="watch" aria-label="${name}님의 테이블 관전하기">관전하기</button>
      <button type="button" class="public-join" data-public-code="${code}" data-public-intent="${intent}" aria-label="${name}님의 테이블 ${action}">${action}</button>
    </div></li>`;
}

const listMarkup = new WeakMap();

export function renderPublicTables(rooms, {loading = false, error = '', capacity} = {}) {
  const list = document.getElementById('public-list');
  const counter = document.getElementById('public-count');
  const status = document.getElementById('public-status');
  const refresh = document.getElementById('public-refresh');
  const uncertain = !rooms.length && (loading || error);
  counter.hidden = Boolean(uncertain);
  counter.textContent = Number.isInteger(capacity) ? rooms.length + ' / ' + capacity : rooms.length + '개';
  counter.title = Number.isInteger(capacity) ? '동시에 열 수 있는 공개 테이블 ' + capacity + '개' : '';
  counter.setAttribute('aria-label', '현재 ' + rooms.length + '개' + (capacity ? ', 최대 ' + capacity + '개' : ''));
  refresh.disabled = loading;
  const message = error ? (error.message || String(error)) : rooms.length ? '' :
    loading ? '공개 테이블을 찾는 중…' : '아직 열린 공개 테이블이 없습니다.';
  if (status.textContent !== message) status.textContent = message;
  status.hidden = !message;
  list.hidden = !rooms.length;
  const html = rooms.map(roomRow).join('');
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
  node.hidden = !snapshot.publicRoom;
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
