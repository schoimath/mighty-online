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

function tableTile(suit, slot, room, loading) {
  const code = 'PUB00' + slot, name = publicTableName(slot);
  const phase = room?.phase;
  const watchable = phase === 'settling' && Boolean(room.watchHandId);
  const state = {empty:'빈 테이블', waiting:'대기 중', playing:'게임 중', finished:'판 종료', settling:watchable ? '마무리 중 · 관전 가능' : '정산 중'}[phase]
    || (loading ? '확인 중' : '확인 불가');
  const canEnter = watchable || ['empty','waiting','playing','finished'].includes(phase);
  const seats = Array.isArray(room?.seats) && room.seats.length === 5 ? room.seats : [];
  const chairs = Array.from({length:5}, (_, seat) => {
    const nickname = typeof seats[seat] === 'string' ? seats[seat].trim() : '';
    return `<div class="public-seat" data-seat="${seat}"><i class="table-chair${nickname ? ' is-seated' : ''}" data-seat="${seat}" aria-hidden="true"></i>
      ${nickname ? '<span class="public-seat-name"><span class="public-sr-only">' + (seat + 1) + '번 자리 </span><bdi>' + escape(nickname) + '</bdi></span>' : ''}</div>`;
  }).join('');
  const action = canEnter ? `<button type="button" class="public-table-enter" data-table-surface data-public-code="${code}"
    data-public-slot="${slot}" data-public-intent="enter"${phase === 'empty' ? ' data-public-empty' : ''} aria-label="${name} 입장하기" aria-describedby="public-phase-${slot}">입장하기</button>` : '';
  return `<li class="public-table-tile" data-suit="${slot}" aria-labelledby="public-table-title-${slot}">
    <h3 class="public-sr-only" id="public-table-title-${slot}">${name}</h3>
    <div class="public-table-scene">${chairs}
      <div class="public-table-rail"><div class="public-table-felt">
        <div class="public-table-caption"><span class="public-table-mark${suit.red ? ' red' : ''}" aria-hidden="true">${suit.mark}</span>
          <span class="public-phase" id="public-phase-${slot}">${state}</span></div>
        ${action}
      </div></div>
    </div></li>`;
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
  const html = suits.map((suit, i) => tableTile(suit, i + 1, slots.get(i + 1), loading)).join('');
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
  const showReservation = spectator && (reservation || !hasVacancy || !snapshot.supportsOpenSeatChoice);
  const prompt = reservation ? reservationLabel(reservation) :
    hasVacancy ? '빈자리에 바로 앉을 수 있습니다.' : '자리가 나면 예약 순서대로 참가합니다.';
  const action = reservation ? '예약 취소' : hasVacancy ? '빈자리 참가' : snapshot.game ? '다음 판 예약' : '자리 예약';
  const roster = spectators.map(person => {
    const queue = reservationLabel(person);
    return '<li><bdi>' + escape(person.name) + '</bdi>' + (queue ? '<small>' + escape(queue) + '</small>' : '') + '</li>';
  }).join('');
  const html = `<div class="audience-heading"><h2>관전자 <span>${spectators.length}명</span></h2></div>
    ${roster ? '<ul class="audience-roster" aria-label="관전자 명단">' + roster + '</ul>' : ''}
    ${showReservation ? `<div class="audience-seat"><p role="status">${escape(prompt)}</p>
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
