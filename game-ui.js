const suitInfo = {
  S: ["♠", "스페이드"], H: ["♥", "하트"], D: ["♦", "다이아몬드"],
  C: ["♣", "클로버"], N: ["NT", "노기루다"],
};
const rankNames = { A: "에이스", K: "킹", Q: "퀸", J: "잭" };
const labels = { bid: "경매", discard: "카드 교환", friend: "프렌드 지정", play: "트릭 진행", result: "라운드 결과" };
const roleLabels = { declarer: "주공", friend: "프렌드", opposition: "수비" };
const cache = new WeakMap();
const TRICK_HOLD_MS = 680;
const COLLECT_MS = 320;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function motionEnabled() {
  return !document.hidden && !reducedMotion.matches;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function cardName(card) {
  if (typeof card !== "string" || !/^(JK|[SHDC](10|[2-9JQKA]))$/.test(card)) throw new Error("카드 정보가 올바르지 않습니다.");
  return card === "JK" ? "조커" : suitInfo[card[0]][1] + " " + (rankNames[card.slice(1)] || card.slice(1));
}
function suitMark(suit) {
  return `<span class="g-suit g-suit-${suit}">${suitInfo[suit][0]}</span>`;
}
function bidName(bid) {
  return bid ? `${suitInfo[bid.suit][0]} ${bid.points}` : "첫 입찰 대기";
}
function cardFace(card) {
  if (card === "JK") {
    return '<span class="g-card-face g-card-joker" aria-hidden="true"><span class="g-corner"><b>J</b><i>★</i></span><span class="g-joker-medallion">★</span><small>JOKER</small></span>';
  }
  const suit = card[0], rank = card.slice(1), mark = suitInfo[suit][0];
  return `<span class="g-card-face g-face-${suit}" aria-hidden="true"><span class="g-corner"><b>${rank}</b><i>${mark}</i></span><span class="g-pip">${mark}</span><i class="g-corner-bottom">${rank}</i></span>`;
}
function callName(call) {
  if (!call) return "미지정";
  return call.kind === "card" ? cardName(call.card) : call.kind === "first" ? "초구 프렌드" : "노프렌드";
}
function select(label, control, options, current) {
  return `<label class="g-field"><span>${label}</span><select data-field="${control}">${options.map(([value, text]) => `<option value="${escapeHtml(value)}"${String(value) === String(current) ? " selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select></label>`;
}
function button(label, name, enabled = true, style = "primary") {
  return `<button type="button" class="g-btn g-${style}" data-do="${name}"${enabled ? "" : " disabled"}>${label}</button>`;
}
function updateDefaults(ui, view) {
  const signature = [view.phase, view.turn, view.dealNo, view.trickNo, view.hand.join("."), view.bid?.points, view.bid?.suit].join("|");
  if (ui.signature === signature) return;
  ui.signature = signature;
  ui.selected = [];
  ui.playIndex = 0;
  const bids = view.choices.bids || [];
  ui.bidSuit = bids[0]?.suit;
  ui.bidPoints = bids[0]?.points;
  ui.contractIndex = Math.max(0, (view.choices.contracts || []).findIndex(c => c.points === view.bid?.points && c.suit === view.bid?.suit));
  const friends = view.choices.friends || [];
  ui.friendKind = friends[0]?.kind;
  ui.friendCard = friends.find(f => f.kind === "card")?.card;
}
function roleAt(view, seat) {
  if (view.declarer === seat) return "주공";
  if (view.friend === seat || (view.seat === seat && view.selfRole === "friend")) return "프렌드";
  if (view.phase === "result") return "수비";
  return "";
}
function seatMarkup(view, nameAt, winner) {
  return Array.from({ length: 5 }, (_, offset) => {
    const seat = (view.seat + offset) % 5, name = nameAt(seat);
    const isTurn = view.turn === seat && view.phase !== "result";
    const role = roleAt(view, seat);
    const captured = view.phase === "play" || view.phase === "result";
    const details = captured ? [role, view.scores[seat] + "점"].filter(Boolean).join(" · ")
      : role || (view.phase === "bid" && view.passed[seat] ? "패스" : (view.counts[seat] + "장"));
    return `<div class="g-seat g-seat-${offset} ${isTurn ? "g-seat-active" : ""} ${winner === seat ? "g-trick-winner" : ""}" data-seat="${seat}"><span class="g-avatar g-avatar-${seat}" aria-hidden="true">${escapeHtml(Array.from(name.trim())[0] || "♠")}</span><span class="g-seat-tag"><span class="g-seat-name">${escapeHtml(name)}${offset === 0 ? '<small>나</small>' : ""}</span><span class="g-seat-detail">${isTurn ? '<i></i>' : ""}${isTurn ? "차례" : escapeHtml(details)}</span></span></div>`;
  }).join("");
}
function setFlightOffset(element, prefix, from, to) {
  const x = from.left + from.width / 2 - to.left - to.width / 2;
  const y = from.top + from.height / 2 - to.top - to.height / 2;
  element.style.setProperty("--" + prefix + "-x", x + "px");
  element.style.setProperty("--" + prefix + "-y", y + "px");
}

function renderTable(ui, nameAt) {
  const {view, root, resolving} = ui;
  const felt = root.querySelector(".g-felt");
  felt.querySelector(".g-seats").innerHTML = seatMarkup(view, nameAt, resolving?.winner);
  const caption = felt.querySelector(".g-trick-result");
  caption.hidden = !resolving;
  caption.textContent = resolving ? nameAt(resolving.winner) + " · " + resolving.points + "점 획득" : "";
  const trick = felt.querySelector(".g-trick");
  const center = felt.querySelector(".g-table-center");
  center.hidden = view.trick.length > 0;
  trick.hidden = !view.trick.length;
  if (trick.hidden || trick.dataset.number !== String(view.trickNo)) {
    trick.replaceChildren();
    trick.classList.remove("g-collecting");
    trick.dataset.number = String(view.trickNo);
  }
  if (!center.hidden) {
    const emptyLabel = view.phase === "play" ? "첫 카드를 기다리는 중" : labels[view.phase];
    center.innerHTML = '<span class="g-table-symbol" aria-hidden="true">♠</span>' + (view.phase === "bid"
      ? `<small>현재 공약</small><strong>${escapeHtml(bidName(view.bid))}</strong>${view.bid ? `<span>${escapeHtml(nameAt(view.bid.seat))}</span>` : ""}`
      : `<strong>${escapeHtml(emptyLabel)}</strong>`);
    return;
  }
  // Keep cards already on the felt mounted when another player acts.
  for (const move of view.trick.slice(trick.children.length)) {
    const label = cardName(move.card);
    const index = trick.children.length;
    trick.insertAdjacentHTML("beforeend", `<div class="g-played" style="--tilt:${(index - 2) * 4}deg"><div class="g-on-table" role="img" aria-label="${label}">${cardFace(move.card)}</div><span>${escapeHtml(nameAt(move.seat))}${move.jokerCall ? " · 조커콜" : move.suit ? " · " + suitInfo[move.suit][0] : ""}</span></div>`);
    if (!motionEnabled()) continue;
    const face = trick.lastElementChild.firstElementChild;
    const ownCard = move.seat === view.seat && root.querySelector(`.g-hand-card[data-card="${move.card}"]`);
    const source = ownCard || felt.querySelector(`[data-seat="${move.seat}"]`);
    setFlightOffset(face, "play", source.getBoundingClientRect(), face.getBoundingClientRect());
    face.style.setProperty("--play-rotate", [-9, -18, -11, 11, 18][(move.seat - view.seat + 5) % 5] + "deg");
    face.classList.add("g-play-enter");
  }
}

function renderHand(ui, newDeal) {
  const {view, root} = ui;
  const hand = root.querySelector(".g-hand");
  if (view.phase === "result") {
    hand.innerHTML = resultTable(view, seat => ui.options.names?.[seat] ?? (seat + 1) + "번 플레이어");
    hand.setAttribute("aria-label", "개인별 획득 점수");
    return;
  }
  let row = hand.querySelector(".g-cards");
  if (!row) {
    hand.setAttribute("aria-label", "내 손패");
    hand.innerHTML = '<div class="g-section-heading"><h2>내 손패 <span></span></h2><span class="g-role"></span></div><div class="g-cards"></div>';
    row = hand.querySelector(".g-cards");
  }
  hand.querySelector("h2 span").textContent = view.hand.length + "장";
  const role = hand.querySelector(".g-role");
  role.textContent = roleLabels[view.selfRole] || "";
  role.hidden = !role.textContent;
  if (newDeal) row.replaceChildren();
  const existing = new Map(Array.from(row.children, el => [el.dataset.card, el]));
  for (const [card, el] of existing) if (!view.hand.includes(card)) el.remove();
  const interactive = view.turn === view.seat && (view.phase === "discard" || view.phase === "play");
  const legal = new Set((view.choices.plays || []).map(move => move.card));
  const mighty = view.bid?.suit === "S" ? "DA" : "SA";
  const arrivals = [];
  for (const [i, card] of view.hand.entries()) {
    const label = cardName(card) + (view.bid && card === mighty ? " · 마이티" : "");
    let el = existing.get(card);
    if (!el) {
      el = document.createElement("button");
      el.type = "button";
      el.className = "g-hand-card";
      el.dataset.card = card;
      el.innerHTML = cardFace(card);
      if (newDeal || view.phase === "discard") arrivals.push(el);
    }
    const selected = ui.selected.includes(card);
    const allowed = interactive && (view.phase === "discard" ? (selected || ui.selected.length < 3) : legal.has(card));
    el.classList.toggle("g-selected", selected);
    el.classList.toggle("g-illegal", interactive && !allowed);
    el.disabled = !allowed;
    el.title = label;
    el.setAttribute("aria-label", label);
    el.setAttribute("aria-pressed", String(selected));
    if (row.children[i] !== el) row.insertBefore(el, row.children[i] || null);
  }
  if (arrivals.length && motionEnabled()) {
    const deck = root.querySelector(".g-felt").getBoundingClientRect();
    arrivals.forEach((el, i) => {
      setFlightOffset(el, "deal", deck, el.getBoundingClientRect());
      el.style.setProperty("--deal-delay", (i * 25) + "ms");
      el.classList.add("g-deal");
    });
  }
}
function bidControls(view, ui) {
  const bids = view.choices.bids;
  const suits = [...new Set(bids.map(b => b.suit))].map(s => [s, suitInfo[s].join(" ")]);
  const points = bids.filter(b => b.suit === ui.bidSuit).map(b => [b.points, b.points + "점"]);
  return `<h2>공약을 정하세요</h2><p>가져올 점수와 기루다 무늬를 정해 입찰하세요.</p>${bids.length ? `<div class="g-input-row">${select("기루다", "bidSuit", suits, ui.bidSuit)}${select("공약 점수", "bidPoints", points, ui.bidPoints)}</div>${button("입찰하기", "bid")}` : ""}${button("패스", "pass", view.choices.canPass, "secondary")}`;
}
function discardControls(view, ui) {
  const contracts = view.choices.contracts || [];
  const opts = contracts.map((c, i) => [i, suitInfo[c.suit].join(" ") + " · " + c.points + "점"]);
  return `<h2>묻을 카드 3장을 고르세요</h2><p>바닥패를 합친 13장 중 3장을 고르세요. 묻은 점수는 주공 팀이 가져갑니다.</p>${contracts.length > 1 ? select("최종 공약", "contractIndex", opts, ui.contractIndex) : ""}${button(`3장 묻기 · ${ui.selected.length}/3`, "discard", ui.selected.length === 3)}`;
}
function friendControls(view, ui) {
  const options = view.choices.friends || [];
  const labelsByKind = { card: "카드로 지정", first: "초구 프렌드", none: "노프렌드" };
  const kinds = [...new Set(options.map(f => f.kind))].map(kind => [kind, labelsByKind[kind]]);
  const cards = options.filter(f => f.kind === "card").map(f => [f.card, cardName(f.card)]);
  return `<h2>프렌드를 정하세요</h2><p>카드를 부르거나 첫 트릭의 승자를 프렌드로 정할 수 있어요. 노프렌드로 혼자 플레이할 수도 있어요.</p>${select("지정 방식", "friendKind", kinds, ui.friendKind)}${ui.friendKind === "card" ? select("프렌드 카드", "friendCard", cards, ui.friendCard) : ""}${button("프렌드 확정", "friend")}`;
}
function playControls(view, ui) {
  const card = ui.selected[0], moves = (view.choices.plays || []).filter(p => p.card === card);
  const opts = moves.map((m, i) => [i, m.suit ? suitInfo[m.suit].join(" ") : m.jokerCall ? "조커콜 선언" : "일반 플레이"]);
  return `<h2>카드를 내세요</h2><p>${view.trick.length ? "낼 수 있는 카드 중 한 장을 고르세요." : "이번 트릭을 시작할 카드를 고르세요."}</p>${moves.length > 1 ? select(card === "JK" ? "요구할 무늬" : "조커콜", "playIndex", opts, ui.playIndex) : ""}${button(card ? cardName(card) + " 내기" : "카드 내기", "play", moves.length > 0)}`;
}
function resultControls(view, ui) {
  const result = view.result;
  return `<h2>주공 팀 ${result.won ? "승리" : "패배"}</h2>
    <p>공약은 ${escapeHtml(result.target)}점, 주공 팀은 ${escapeHtml(result.points)}점을 획득했어요.</p>
    <div class="g-result-score"><strong>${escapeHtml(result.points)}</strong><span>/ 20점</span></div>
    ${ui.options.isHost ? button(escapeHtml(ui.options.replayLabel || "다시 한 판"), "replay") : "<p>방장이 다음 판을 시작할 수 있어요.</p>"}`;
}
function previousTrick(view, nameAt) {
  const last = view.lastTrick;
  if (!last) return "";
  return `<details class="g-log"><summary>지난 트릭 <b>${escapeHtml(nameAt(last.winner))} 승리</b></summary><p>${escapeHtml(last.number)}트릭 · ${escapeHtml(last.points)}점 획득</p><ul>${last.cards.map(m => `<li><span>${escapeHtml(nameAt(m.seat))}</span><strong>${m.card === "JK" ? "★ 조커" : suitMark(m.card[0]) + " " + escapeHtml(m.card.slice(1))}</strong></li>`).join("")}</ul></details>`;
}
function infoMarkup(view, nameAt) {
  const rows = [];
  if (view.bid) rows.push(["공약", suitInfo[view.bid.suit].join(" ") + " · " + view.bid.points + "점"]);
  if (view.declarer != null) rows.push(["주공", nameAt(view.declarer)]);
  if (view.call) rows.push(["프렌드", view.friendKnown && view.friend == null ? "노프렌드" : (view.friend != null ? nameAt(view.friend) + " · " : "") + callName(view.call)]);
  if (view.phase === "play") rows.push(["진행", view.trickNo + " / 10 트릭"]);
  if (view.phase === "bid" && view.bid) rows.push(["최고 입찰자", nameAt(view.bid.seat)]);
  return rows.length ? `<dl class="g-info">${rows.map(([a, b]) => `<div><dt>${a}</dt><dd>${escapeHtml(b)}</dd></div>`).join("")}</dl>` : "";
}
function panelMarkup(view, ui, nameAt) {
  if (ui.resolving) {
    const last = ui.resolving;
    return `<div class="g-panel-body"><div class="g-panel-caption">트릭 결과</div><div class="g-action" aria-live="polite"><h2>${escapeHtml(nameAt(last.winner))} 승리</h2><p>${escapeHtml(last.number)}번째 트릭에서 ${escapeHtml(last.points)}점을 가져갔어요.</p></div>${infoMarkup(view, nameAt)}</div>${previousTrick(view, nameAt)}`;
  }
  const mine = view.seat === view.turn;
  const controls = { bid: bidControls, discard: discardControls, friend: friendControls, play: playControls, result: resultControls };
  const waiting = view.phase !== "result" && !mine;
  const content = waiting ? `<h2>${escapeHtml(nameAt(view.turn))}님 차례</h2><p>${({ bid: "입찰을 기다리고 있어요.", discard: "주공이 바닥패를 교환하고 있어요.", friend: "주공이 프렌드를 정하고 있어요.", play: "카드를 고르고 있어요." })[view.phase]}</p>` : controls[view.phase](view, ui);
  return `<div class="g-panel-body"><div class="g-panel-caption"><i class="${waiting ? "g-wait-dot" : ""}"></i>${view.phase === "result" ? "최종 결과" : mine ? "내 차례" : "상대 차례"}</div><div class="g-action" aria-live="polite">${content}</div>${infoMarkup(view, nameAt)}</div>${previousTrick(view, nameAt)}`;
}
function resultTable(view, nameAt) {
  return `<div class="g-section-heading"><h2>개인별 획득 점수</h2></div><ul class="g-tally">${view.scores.map((score, seat) => `<li><span>${escapeHtml(nameAt(seat))} <small>${roleAt(view, seat)}</small></span><b>${escapeHtml(score)}점</b></li>`).join("")}</ul>`;
}
function mountTable(root) {
  root.innerHTML = `<div class="g-screen">
    <header class="g-nav"><div class="g-nav-inner">
      <div class="g-brand"><i aria-hidden="true">♠</i><span>Mighty Club</span></div>
      <span class="g-nav-divider"></span><span class="g-nav-phase">게임 테이블</span>
      <div class="g-nav-actions">${button("게임 규칙", "rules", true, "top")}${button("나가기", "leave", true, "top")}</div>
    </div></header>
    <div class="g-main">
      <div class="g-heading"><div><div class="g-eyebrow"><i aria-hidden="true">♠</i> 마이티 · 5인전</div><h1></h1></div><span class="g-round-tag"></span></div>
      <div class="g-layout">
        <section class="g-board" aria-label="게임 테이블"><div class="g-felt"><div class="g-felt-line"></div>
          <div class="g-table-center"></div><div class="g-trick" hidden></div><div class="g-seats"></div>
          <p class="g-trick-result" hidden></p></div></section>
        <section class="g-hand"></section><aside class="g-panel"></aside>
      </div>
    </div></div>`;
}
function redraw(ui, newDeal = false) {
  const { view, options, root } = ui;
  const nameAt = seat => String(options.names?.[seat] ?? ((seat + 1) + "번 플레이어"));
  const focused = root.contains(document.activeElement) ? document.activeElement : null;
  const oldFocus = focused && ["card", "field", "do"].map(attr => [attr, focused.dataset[attr]]).find(([, value]) => value != null);
  const openLog = root.querySelector(".g-log")?.open;
  root.querySelector("h1").textContent = view.phase === "play" ? `${view.trickNo}번째 트릭` : labels[view.phase];
  root.querySelector(".g-round-tag").textContent = view.phase === "result" ? "10트릭 완료"
    : view.phase === "bid" ? "경매 " + view.bidHistory.length + "회"
    : "기루다 · " + suitInfo[view.bid.suit].join(" ");
  // Read the departing card's position before reconciling the player's hand.
  renderTable(ui, nameAt);
  renderHand(ui, newDeal);
  const panel = root.querySelector(".g-panel");
  panel.innerHTML = panelMarkup(view, ui, nameAt);
  panel.classList.toggle("g-result-arrive", view.phase === "result");
  if (openLog && panel.querySelector(".g-log")) panel.querySelector(".g-log").open = true;
  if (oldFocus) root.querySelector(`[data-${oldFocus[0]}="${oldFocus[1]}"]`)?.focus({ preventScroll: true });
}
function submit(ui, kind) {
  const { view } = ui;
  if (kind === "pass" && view.choices.canPass) return { type: "pass" };
  if (kind === "bid") {
    const bid = view.choices.bids.find(b => b.points === ui.bidPoints && b.suit === ui.bidSuit);
    return bid && { type: "bid", ...bid };
  }
  if (kind === "discard" && ui.selected.length === 3) {
    const contract = view.choices.contracts?.[ui.contractIndex];
    return { type: "discard", cards: [...ui.selected], ...(contract ? { contract } : {}) };
  }
  if (kind === "friend") {
    const friend = view.choices.friends.find(f => f.kind === ui.friendKind && (f.kind !== "card" || f.card === ui.friendCard));
    return friend && { type: "friend", ...friend };
  }
  if (kind === "play") {
    const move = view.choices.plays.filter(p => p.card === ui.selected[0])[ui.playIndex];
    return move && { type: "play", ...move };
  }
}
function bind(ui) {
  ui.root.addEventListener("animationend", event => {
    if (event.animationName === "g-deal-card") event.target.closest(".g-hand-card")?.classList.remove("g-deal");
    if (event.animationName === "g-play-card") event.target.classList.remove("g-play-enter");
  });
  ui.root.addEventListener("click", event => {
    if (!ui.root.querySelector(".g-screen")) return;
    const el = event.target.closest("button");
    if (!el || el.disabled) return;
    if (el.dataset.card) {
      const card = el.dataset.card;
      if (ui.view.phase === "discard") {
        ui.selected = ui.selected.includes(card) ? ui.selected.filter(c => c !== card) : [...ui.selected, card];
      } else {
        ui.selected = [card];
        ui.playIndex = 0;
      }
      redraw(ui);
      return;
    }
    const kind = el.dataset.do;
    if (kind === "rules") return ui.options.onRules?.();
    if (kind === "leave") return ui.options.onLeave?.();
    if (kind === "replay") return ui.options.onReplay?.();
    if (kind && ui.view.seat === ui.view.turn) {
      const action = submit(ui, kind);
      if (action) ui.options.onAction(action);
    }
  });
  ui.root.addEventListener("change", event => {
    const el = event.target;
    if (!el.matches(".g-field select")) return;
    const field = el.dataset.field;
    ui[field] = ["bidPoints", "contractIndex", "playIndex"].includes(field) ? Number(el.value) : el.value;
    if (field === "bidSuit") {
      const bids = ui.view.choices.bids.filter(b => b.suit === ui.bidSuit);
      if (!bids.some(b => b.points === ui.bidPoints)) ui.bidPoints = bids[0].points;
    }
    redraw(ui);
  });
}

function displayLatest(ui) {
  const view = ui.latest;
  const previous = ui.view;
  const newDeal = view.phase === "bid" && (previous?.phase !== "bid" || previous.dealNo !== view.dealNo);
  ui.view = view;
  updateDefaults(ui, view);
  redraw(ui, newDeal);
}

function finishCollection(ui) {
  ui.resolving = null;
  displayLatest(ui);
}

function collectTrick(ui) {
  if (!motionEnabled()) { finishCollection(ui); return; }
  const trick = ui.root.querySelector(".g-trick");
  const seat = ui.root.querySelector(`[data-seat="${ui.resolving.winner}"]`).getBoundingClientRect();
  for (const [i, el] of Array.from(trick.children).entries()) {
    setFlightOffset(el, "collect", seat, el.firstElementChild.getBoundingClientRect());
    el.style.setProperty("--collect-rotate", ((2 - i) * 7) + "deg");
  }
  trick.classList.add("g-collecting");
  ui.timer = setTimeout(() => finishCollection(ui), COLLECT_MS);
}

export function clearGame(container) {
  const ui = cache.get(container);
  if (!ui) return;
  clearTimeout(ui.timer);
  ui.view = ui.latest = ui.resolving = ui.signature = null;
  container.replaceChildren();
}

export function renderGame(container, publicView, options = {}) {
  let ui = cache.get(container);
  if (!ui) {
    ui = { root: container };
    cache.set(container, ui);
    bind(ui);
  }
  if (!container.firstElementChild) mountTable(container);
  ui.latest = publicView;
  ui.options = options;
  if (ui.resolving) {
    // Peers can send the next lead while this client is gathering the trick.
    // Keep the newest snapshot and never dispatch actions from the held frame.
    if (!document.hidden && publicView.phase !== "bid" && publicView.lastTrick?.number === ui.resolving.number) return;
    clearTimeout(ui.timer);
    ui.resolving = null;
  }
  const last = publicView.lastTrick;
  if (!document.hidden && last && ui.view?.phase === "play" && ui.view.trickNo === last.number && ui.view.lastTrick?.number !== last.number) {
    ui.resolving = last;
    ui.view = {...publicView, phase: "play", trickNo: last.number, trick: last.cards, turn: null};
    updateDefaults(ui, ui.view);
    redraw(ui);
    ui.timer = setTimeout(() => collectTrick(ui), TRICK_HOLD_MS);
    return;
  }
  displayLatest(ui);
}

export function rulesContent() {
  return `<div class="g-rules">
    <p>다섯 명이 열 번의 트릭을 플레이합니다. 주공과 프렌드는 공약한 점수를 모으고, 나머지 플레이어는 이를 막습니다.</p>
    <h3>경매와 바닥패</h3><p>조커 한 장을 포함한 53장 중 각자 10장씩 받고 3장은 바닥에 둡니다. 13~20점 사이에서 점수와 기루다(으뜸 무늬)를 제시하거나 패스하세요. 같은 점수에서는 노기루다가 무늬 공약보다 높습니다. 모두 패스하면 다시 나눕니다.</p>
    <p>경매의 승자인 주공은 바닥패를 가져와 3장을 묻습니다. 이때 기루다를 바꾸려면 공약을 2점 이상 올려야 합니다. 묻은 점수는 주공 팀의 점수입니다.</p>
    <h3>프렌드</h3><p>주공이 부른 카드를 가진 사람이 프렌드입니다. 그 카드가 나오면 모두에게 정체가 공개됩니다. 첫 트릭을 이긴 사람을 부르는 초구 프렌드나, 혼자 하는 노프렌드도 선택할 수 있습니다. 주공 자신이 가진 카드나 묻은 카드를 부르면 혼자 플레이합니다.</p>
    <h3>카드 내기</h3><p>주공부터 한 장씩 냅니다. 선이 낸 무늬가 손에 있으면 따라야 합니다. 마이티와 조커는 무늬에 관계없이 낼 수 있습니다. 첫 트릭에서는 다른 무늬를 낼 수 있으면 기루다로 시작할 수 없습니다. 트릭을 이긴 사람이 다음 선입니다.</p>
    <h3>마이티와 조커</h3><p>가장 센 카드는 스페이드 A입니다. 스페이드가 기루다일 때는 다이아몬드 A가 마이티입니다. 그다음은 조커, 기루다, 선의 무늬 순입니다. 같은 무늬 안에서는 A가 가장 높고 2가 가장 낮습니다.</p>
    <p>첫 트릭과 마지막 트릭에서 조커는 가장 약합니다. 이때 조커로 시작하면 두 번째 카드가 따를 무늬를 정합니다. 2~9번째 트릭에서 조커로 시작하면 원하는 무늬를 부릅니다.</p>
    <p>첫 트릭 이후 선이 클로버 3으로 조커콜을 선언하면 조커를 가진 사람은 조커 또는 마이티를 내야 합니다. 이 트릭에서 조커는 가장 약합니다. 클로버가 기루다일 때의 조커콜 카드는 스페이드 3입니다.</p>
    <h3>승패</h3><p>10, J, Q, K, A는 각각 1점으로, 한 판에는 총 20점이 있습니다. 열 번째 트릭이 끝났을 때 주공 팀의 점수가 공약 이상이면 주공 팀이 승리합니다.</p>
  </div>`;
}
