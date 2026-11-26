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

// These cards form one opposition pile, with no seat-of-origin information.
export function settingPenaltyPile(view) {
  const cards = view.settingPenaltyCards?.filter(isPointCard);
  if (view.phase !== 'result' || view.result?.setting?.success !== false || !cards?.length) return '';
  const master = mighty(view.bid.suit);
  return '<div class="g-setting-pile" role="group" aria-label="세팅 페널티로 야당이 받은 점수 카드">' +
    cards.map(card => pointCard(card, master)).join('') + '</div>';
}

export function seatStanding(board, seat, beforeSettlement = false) {
  const panelMemberId = board?.panelMemberIds?.[seat];
  const member = board?.members?.find(entry => panelMemberId == null ? entry.seat === seat : entry.id === panelMemberId);
  if (!Number.isSafeInteger(member?.total)) return '';
  const previousChange = beforeSettlement && Number.isSafeInteger(member.lastDelta) ? member.lastDelta : 0;
  const points = member.total - previousChange;
  const total = signedScore(points);
  return `<span class="seat-standing" data-total-seat="${seat}" data-sign="${Math.sign(points)}" title="경기 누적 점수 ${total}점"><span class="visually-hidden">경기 누적 점수 </span><b>${total}</b>점</span>`;
}

export function scoreTable(board, mySeat, {collapsed = false, final = false, title = '누적 점수'} = {}) {
  if (!Number.isSafeInteger(board?.rounds) || !Array.isArray(board.members)) return '';
  const members = final ? board.members.filter(member => Number.isSafeInteger(member.rank))
    .sort((a, b) => a.rank - b.rank) : board.members;
  const rows = members.map((member, index) => {
    const name = String(member.name).replace(/[&<>]/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;'}[c]));
    const seat = Number.isInteger(member.seat) ? member.seat + 1 + '번' : '이전 참가자';
    const mine = Number.isInteger(mySeat) && member.seat === mySeat;
    const tied = final && (members[index - 1]?.rank === member.rank || members[index + 1]?.rank === member.rank);
    const rank = final ? `<td class="standing-rank">${tied ? '공동 ' : ''}${member.rank}위</td>` : '';
    return `<tr${mine ? ' class="standing-mine"' : ''}>${rank}<th scope="row"><small>${seat}</small> ${name}${mine ? ' <small>나</small>' : ''}</th>
      <td>${signedScore(member.lastDelta)}</td><td><strong>${signedScore(member.total)}</strong></td></tr>`;
  }).join('');
  const heading = `${title} <small>${board.rounds}판 완료</small>`;
  const table = `<table aria-label="${title}"><thead><tr>${final ? '<th scope="col">순위</th>' : ''}<th scope="col">참가자</th><th scope="col">${final ? '마지막 판' : '직전 판'}</th><th scope="col">누적</th></tr></thead><tbody>${rows}</tbody></table>`;
  if (final) return `<div class="match-standings match-final"><h2>${title}</h2>${table}</div>`;
  return collapsed
    ? `<details class="match-standings"><summary>${heading}</summary>${table}</details>`
    : `<section class="match-standings"><h3>${heading}</h3>${table}</section>`;
}
