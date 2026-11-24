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
