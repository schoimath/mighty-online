const suitMarks = { S: '♠', H: '♥', D: '♦', C: '♣' };
const suitNames = { S: '스페이드', H: '하트', D: '다이아몬드', C: '클로버' };
const isPointCard = card => typeof card === 'string' && /^[SHDC](10|J|Q|K|A)$/.test(card);

export function isCoveredSeat(view, seat) {
  return seat === view.declarer || seat === view.friend;
}

function pointCard(card) {
  const suit = card[0], rank = card.slice(1);
  const red = suit === 'H' || suit === 'D';
  return `<span class="g-score-card${red ? ' g-score-red' : ''}" data-score-card="${card}" aria-label="${suitNames[suit]} ${rank}">${suitMarks[suit]}${rank}</span>`;
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
  return `${anchor}<strong class="g-score-total" aria-label="획득 점수 ${total}점">${total}점</strong>${cards.map(pointCard).join('')}</div>`;
}
