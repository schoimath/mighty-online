const suitMarks = { S: '♠', H: '♥', D: '♦', C: '♣' };
const suitNames = { S: '스페이드', H: '하트', D: '다이아몬드', C: '클로버' };
const isPointCard = card => typeof card === 'string' && /^[SHDC](10|J|Q|K|A)$/.test(card);

function pointCard(card, buried) {
  const face = document.createElement('span');
  const suit = card[0];
  face.className = 'g-score-card';
  face.classList.toggle('g-score-red', suit === 'H' || suit === 'D');
  face.classList.toggle('g-score-buried', buried);
  face.dataset.scoreCard = card;
  face.textContent = suitMarks[suit] + card.slice(1);
  face.title = suitNames[suit] + ' ' + card.slice(1) + (buried ? ' · 묻은 카드' : '');
  face.setAttribute('aria-label', face.title);
  return face;
}

function mountScoreboard(container) {
  container.innerHTML = `<div class="g-score-heading"><h2>획득 점수</h2><span class="g-score-last" role="status"></span></div>
    <ul class="g-score-list"></ul><p class="g-score-note" hidden></p>`;
  const list = container.querySelector('.g-score-list');
  for (let seat = 0; seat < 5; seat++) {
    const row = document.createElement('li');
    row.className = 'g-score-seat';
    row.dataset.scoreSeat = String(seat);
    row.innerHTML = `<div class="g-score-line"><span class="g-score-name"></span><strong class="g-score-total"></strong></div>
      <div class="g-score-cards"></div>`;
    list.append(row);
  }
}

export function renderScoreboard(container, view, nameAt) {
  container.hidden = view.phase !== 'play' && view.phase !== 'result';
  if (container.hidden) {
    if (container.firstChild) container.replaceChildren();
    return;
  }
  const initial = !container.firstChild;
  if (initial) mountScoreboard(container);
  const last = view.lastTrick;
  const status = container.querySelector('.g-score-last');
  const message = last ? `${last.number}트릭 · ${nameAt(last.winner)} +${last.points}점` : '';
  if (status.textContent !== message) status.textContent = message;
  status.hidden = !last;
  const buried = view.phase === 'result' ? view.discarded.filter(isPointCard) : [];
  const note = container.querySelector('.g-score-note');
  note.hidden = !buried.length;
  if (buried.length) note.textContent = `주공 점수에 묻은 카드 ${buried.length}점 포함 · 점선으로 표시`;

  for (const [seat, row] of Array.from(container.querySelector('.g-score-list').children).entries()) {
    const name = String(nameAt(seat));
    const role = seat === view.declarer ? '주공' : seat === view.friend ? '프렌드' : view.phase === 'result' ? '수비' : '';
    const nameTag = row.querySelector('.g-score-name');
    const label = [name, role].filter(Boolean).join(' · ');
    nameTag.textContent = label;
    nameTag.title = label;
    row.classList.toggle('g-score-winner', seat === last?.winner);

    const captured = view.captured?.[seat] || [];
    const withBuried = seat === view.declarer ? captured.concat(buried) : captured;
    // Older hosts send numeric scores without a card ledger.
    const total = view.captured ? withBuried.length : view.scores[seat];
    row.querySelector('.g-score-total').textContent = total + '점';
    const pile = row.querySelector('.g-score-cards');
    for (const [index, card] of withBuried.entries()) {
      if (pile.children[index]?.dataset.scoreCard === card) continue;
      const face = pointCard(card, index >= captured.length);
      if (!initial && !document.hidden) face.classList.add('g-score-arrival');
      if (pile.children[index]) pile.children[index].replaceWith(face);
      else pile.append(face);
    }
    while (pile.children.length > withBuried.length) pile.lastElementChild.remove();
  }
}
