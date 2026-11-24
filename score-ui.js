import {mighty} from './engine.js';

const suitMarks = { S: '♠', H: '♥', D: '♦', C: '♣' };
const suitNames = { S: '스페이드', H: '하트', D: '다이아몬드', C: '클로버' };
const isPointCard = card => typeof card === 'string' && /^[SHDC](10|J|Q|K|A)$/.test(card);

export function isCoveredSeat(view, seat) {
  return seat === view.declarer || seat === view.friend;
}

function pointCard(card, master) {
  const suit = card[0], rank = card.slice(1);
  const red = suit === 'H' || suit === 'D';
  const isMighty = card === master;
  const label = suitNames[suit] + ' ' + rank + (isMighty ? ' · 마이티' : '');
  return `<span class="g-score-card${red ? ' g-score-red' : ''}${isMighty ? ' g-score-mighty' : ''}" data-score-card="${card}" title="${label}" aria-label="${label}">${suitMarks[suit]}${rank}${isMighty ? '<sup aria-hidden="true">★</sup>' : ''}</span>`;
}

export function seatPile(view, seat) {
  if (view.phase !== 'play' && view.phase !== 'result') return '';
  const anchor = `<div class="g-score-anchor" data-score-seat="${seat}">`;
  if (isCoveredSeat(view, seat)) {
    return anchor + '<span class="g-score-covered" aria-label="덮은 점수 카드"><i aria-hidden="true"></i>덮음</span></div>';
  }

  const cards = (view.captured?.[seat] || []).filter(isPointCard);
  // Older hosts may send a total without the underlying cards.
  const total = view.captured ? cards.length : Number(view.scores[seat]) || 0;
  const master = view.bid && mighty(view.bid.suit);
  return `${anchor}<strong class="g-score-total" aria-label="획득 점수 ${total}점">${total}점</strong>${cards.map(card => pointCard(card, master)).join('')}</div>`;
}

export function signedScore(points) {
  return Number.isSafeInteger(points) ? (points > 0 ? '+' : '') + points : '—';
}

export function scoreTable(board, mySeat, {collapsed = false, title = '누적 점수'} = {}) {
  if (!Number.isSafeInteger(board?.rounds) || !Array.isArray(board.members)) return '';
  const rows = board.members.map(member => {
    const name = String(member.name).replace(/[&<>]/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;'}[c]));
    const seat = Number.isInteger(member.seat) ? member.seat + 1 + '번' : '이전';
    const mine = Number.isInteger(mySeat) && member.seat === mySeat;
    return `<tr${mine ? ' class="standing-mine"' : ''}><th scope="row"><small>${seat}</small> ${name}${mine ? ' <small>나</small>' : ''}</th>
      <td>${signedScore(member.lastDelta)}</td><td><strong>${signedScore(member.total)}</strong></td></tr>`;
  }).join('');
  const heading = `${title} <small>${board.rounds}판 완료</small>`;
  const table = `<table aria-label="${title}"><thead><tr><th scope="col">참가자</th><th scope="col">직전 판</th><th scope="col">누적</th></tr></thead><tbody>${rows}</tbody></table>`;
  return collapsed
    ? `<details class="match-standings"><summary>${heading}</summary>${table}</details>`
    : `<section class="match-standings"><h3>${heading}</h3>${table}</section>`;
}
