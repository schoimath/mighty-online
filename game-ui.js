import {isCoveredSeat, seatPile} from "./score-ui.js";
import {DEFAULT_RULES, mighty} from "./engine.js";
import {playTableSound, soundControl, toggleSound} from "./sound.js";

const suitInfo = {
  S: ["♠", "스페이드"], H: ["♥", "하트"], D: ["♦", "다이아몬드"],
  C: ["♣", "클로버"], N: ["NT", "노기루다"],
};
const rankNames = { A: "에이스", K: "킹", Q: "퀸", J: "잭" };
const labels = { bid: "경매", discard: "카드 교환", friend: "프렌드 지정", play: "트릭 진행", result: "라운드 결과" };
const roleLabels = { declarer: "주공", friend: "프렌드", opposition: "수비" };
const cache = new WeakMap();
const TRICK_HOLD_MS = 810;
const COLLECT_MS = 390;
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
function longestSuit(hand, availableSuits) {
  const lengths = { S: 0, H: 0, D: 0, C: 0 };
  for (const card of hand) if (card !== "JK") lengths[card[0]]++;
  return availableSuits.reduce((best, suit) =>
    (lengths[suit] ?? -1) > (lengths[best] ?? -1) ? suit : best, availableSuits[0]);
}
function bidSeat(seat) {
  return `<span class="g-bid-seat g-avatar-${seat}" aria-label="${seat + 1}번 자리">${seat + 1}</span>`;
}
function leadingBidMarkup(view, nameAt) {
  if (!view.bid) return '<span class="g-table-symbol" aria-hidden="true">♠</span><strong>첫 입찰 대기</strong>';
  const bid = view.bid;
  const latestBid = view.bidHistory.findLast(entry => !entry.pass);
  const bidder = latestBid?.name ?? nameAt(bid.seat);
  return `<div class="g-leading-bid">
    <small>현재 최고 공약</small>
    <strong aria-label="${suitInfo[bid.suit][1]} ${escapeHtml(bid.points)}점">${suitMark(bid.suit)} ${escapeHtml(bid.points)}<span>점</span></strong>
    <div class="g-bidder">${bidSeat(bid.seat)}<b title="${escapeHtml(bidder)}">${escapeHtml(bidder)}</b></div>
  </div>`;
}
function cardFace(card) {
  if (card === "JK") {
    return '<span class="g-card-face g-card-joker" aria-hidden="true"><span class="g-corner"><b>J</b><i>★</i></span><span class="g-joker-medallion">★</span><small>JOKER</small></span>';
  }
  const suit = card[0], rank = card.slice(1), mark = suitInfo[suit][0];
  return `<span class="g-card-face g-face-${suit}" aria-hidden="true"><span class="g-corner"><b>${rank}</b><i>${mark}</i></span><span class="g-pip">${mark}</span><i class="g-corner-bottom">${rank}</i></span>`;
}
function callName(call, trump) {
  if (!call) return "미지정";
  if (call.kind === "card") return call.card === mighty(trump) ? "마이티 프렌드" : cardName(call.card);
  return call.kind === "first" ? "초구 프렌드" : "노프렌드";
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
  const jokerSuits = view.choices.plays.filter(move => move.card === "JK" && move.suit).map(move => move.suit);
  ui.jokerSuit = jokerSuits.length ? longestSuit(view.hand, jokerSuits) : null;
  ui.jokerCall = false;
  const bids = view.choices.bids || [];
  ui.bidSuit = longestSuit(view.hand, [...new Set(bids.map(bid => bid.suit))]);
  ui.bidPoints = bids.find(bid => bid.suit === ui.bidSuit)?.points;
  ui.contractIndex = Math.max(0, (view.choices.contracts || []).findIndex(c => c.points === view.bid?.points && c.suit === view.bid?.suit));
  const friends = view.choices.friends || [];
  ui.friendKind = friends[0]?.kind;
  ui.friendCard = friends.find(f => f.kind === "card")?.card;
}
function roleAt(view, seat) {
  if (view.declarer === seat) return "주공";
  if (view.friend === seat || (view.seat === seat && view.selfRole === "friend")) {
    return view.call?.kind === "card" && view.call.card === mighty(view.bid.suit) ? "마이티 프렌드" : "프렌드";
  }
  if (view.phase === "result") return "수비";
  return "";
}
function seatMarkup(view, nameAt, winner) {
  return Array.from({ length: 5 }, (_, offset) => {
    const seat = (view.seat + offset) % 5, name = nameAt(seat);
    const isTurn = view.turn === seat && view.phase !== "result";
    const role = roleAt(view, seat);
    const playing = view.phase === "play" || view.phase === "result";
    const inAuction = view.phase === "bid";
    const lastBid = inAuction && view.bidHistory.findLast(entry => entry.seat === seat);
    const bidLabel = lastBid ? (lastBid.pass ? "패스" : suitInfo[lastBid.suit][0] + " " + lastBid.points + "점") : "";
    const details = role || bidLabel || (playing ? "" : view.counts[seat] + "장");
    const status = [isTurn ? "차례" : "", details].filter(Boolean).join(" · ");
    const leader = inAuction && view.bid?.seat === seat;
    const avatar = inAuction ? seat + 1 : Array.from(name.trim())[0] || "♠";
    const header = `<span class="g-avatar g-avatar-${seat}" aria-label="${seat + 1}번 자리">${escapeHtml(avatar)}</span><span class="g-seat-tag"><span class="g-seat-name">${escapeHtml(name)}${offset === 0 ? '<small>나</small>' : ""}</span><span class="g-seat-detail">${isTurn ? '<i></i>' : ""}${escapeHtml(status)}</span></span>`;
    return `<div class="g-seat g-seat-${offset} ${isTurn ? "g-seat-active" : ""} ${leader ? "g-seat-bidder" : ""} ${winner === seat ? "g-trick-winner" : ""}" data-seat="${seat}" role="group" aria-label="${escapeHtml(name)} 자리">${playing ? '<div class="g-seat-head">' + header + '</div>' + seatPile(view, seat) : header}</div>`;
  }).join("");
}
function setFlightOffset(element, prefix, from, to) {
  const x = from.left + from.width / 2 - to.left - to.width / 2;
  const y = from.top + from.height / 2 - to.top - to.height / 2;
  element.style.setProperty("--" + prefix + "-x", x + "px");
  element.style.setProperty("--" + prefix + "-y", y + "px");
}

function dealToOtherSeats(root, localSeat) {
  const felt = root.querySelector(".g-felt");
  felt.querySelectorAll(".g-flight-back").forEach(card => card.remove());
  if (!motionEnabled()) return;
  const deck = felt.getBoundingClientRect();
  for (let offset = 1; offset < 5; offset++) {
    const destination = felt.querySelector(`[data-seat="${(localSeat + offset) % 5}"]`).getBoundingClientRect();
    const card = document.createElement("i");
    card.className = "g-flight-back";
    card.setAttribute("aria-hidden", "true");
    setFlightOffset(card, "flight", destination, deck);
    card.style.setProperty("--deal-delay", (offset * 65) + "ms");
    felt.append(card);
  }
}

function renderTable(ui, nameAt) {
  const {view, root, resolving} = ui;
  const felt = root.querySelector(".g-felt");
  felt.classList.toggle("g-with-piles", view.phase === "play" || view.phase === "result");
  felt.querySelector(".g-seats").innerHTML = seatMarkup(view, nameAt, resolving?.winner);
  const caption = felt.querySelector(".g-trick-result");
  caption.hidden = !resolving;
  caption.textContent = resolving ? nameAt(resolving.winner) + " · " +
    (isCoveredSeat(view, resolving.winner) ? "트릭 승리" : resolving.points + "점 획득") : "";
  const trick = felt.querySelector(".g-trick");
  const center = felt.querySelector(".g-table-center");
  center.hidden = view.trick.length > 0;
  trick.hidden = !view.trick.length;
  if (trick.hidden || trick.dataset.number !== String(view.trickNo)) {
    trick.replaceChildren();
    trick.classList.remove("g-collecting", "g-collect-covered");
    trick.dataset.number = String(view.trickNo);
  }
  if (!center.hidden) {
    const emptyLabel = view.phase === "play" ? "첫 카드를 기다리는 중" : labels[view.phase];
    const markup = view.phase === "bid" ? leadingBidMarkup(view, nameAt)
      : `<span class="g-table-symbol" aria-hidden="true">♠</span><strong>${escapeHtml(emptyLabel)}</strong>`;
    if (ui.centerMarkup !== markup) {
      center.innerHTML = markup;
      ui.centerMarkup = markup;
    }
    return;
  }
  // Keep cards already on the felt mounted when another player acts.
  for (const move of view.trick.slice(trick.children.length)) {
    const offset = (move.seat - view.seat + 5) % 5;
    const isMighty = move.card === mighty(view.bid.suit);
    const label = escapeHtml(nameAt(move.seat)) + " · " + cardName(move.card) + (isMighty ? " · 마이티" : "");
    const caption = move.jokerCall ? "조커콜" : move.suit ? suitInfo[move.suit][0] + " 요구" : escapeHtml(nameAt(move.seat));
    trick.insertAdjacentHTML("beforeend", `<div class="g-played g-played-${offset}" data-play-seat="${move.seat}"><div class="g-on-table${isMighty ? " g-mighty-play" : ""}" role="img" aria-label="${label}">${cardFace(move.card)}${isMighty ? '<b class="g-mighty-tag" aria-hidden="true">마이티</b>' : ""}</div><span class="g-play-label">${caption}</span></div>`);
    if (!motionEnabled()) continue;
    const face = trick.lastElementChild.firstElementChild;
    const ownCard = move.seat === view.seat && root.querySelector(`.g-hand-card[data-card="${move.card}"]`);
    const source = ownCard || felt.querySelector(`[data-seat="${move.seat}"]`);
    setFlightOffset(face, "play", source.getBoundingClientRect(), face.getBoundingClientRect());
    face.style.setProperty("--play-rotate", [-9, -18, -11, 11, 18][offset] + "deg");
    face.classList.add("g-play-enter");
  }
}

function renderHand(ui, newDeal) {
  const {view, root} = ui;
  const hand = root.querySelector(".g-hand");
  hand.hidden = view.phase === "result";
  if (hand.hidden) return;
  let row = hand.querySelector(".g-cards");
  if (!row) {
    hand.setAttribute("aria-label", "내 손패");
    hand.innerHTML = '<div class="g-section-heading"><h2>내 손패 <span></span></h2><span class="g-role"></span></div><div class="g-play-settings" hidden></div><div class="g-cards"></div>';
    row = hand.querySelector(".g-cards");
  }
  hand.querySelector("h2 span").textContent = view.hand.length + "장";
  const role = hand.querySelector(".g-role");
  role.textContent = roleAt(view, view.seat) || roleLabels[view.selfRole] || "";
  role.hidden = !role.textContent;
  if (newDeal) row.replaceChildren();
  const existing = new Map(Array.from(row.children, el => [el.dataset.card, el]));
  for (const [card, el] of existing) if (!view.hand.includes(card)) el.remove();
  const interactive = view.turn === view.seat && !ui.playPending && (view.phase === "discard" || view.phase === "play");
  const settings = hand.querySelector(".g-play-settings");
  const settingsHtml = interactive && view.phase === "play" ? specialPlaySettings(view, ui) : "";
  if (settingsHtml !== ui.settingsHtml) {
    settings.innerHTML = settingsHtml;
    ui.settingsHtml = settingsHtml;
  }
  settings.hidden = !settingsHtml;
  const legal = new Set((view.choices.plays || []).map(move => move.card));
  const mightyCard = view.bid && mighty(view.bid.suit);
  const arrivals = [];
  for (const [i, card] of view.hand.entries()) {
    let label = cardName(card) + (card === mightyCard ? " · 마이티" : "");
    if (view.phase === "play" && interactive) {
      if (card === "JK" && ui.jokerSuit) label += " · " + suitInfo[ui.jokerSuit][1] + " 요구";
      if (ui.jokerCall && view.choices.plays.some(move => move.card === card && move.jokerCall)) label += " · 조커콜";
    }
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
    if (view.phase === "discard") el.setAttribute("aria-pressed", String(selected));
    else el.removeAttribute("aria-pressed");
    if (row.children[i] !== el) row.insertBefore(el, row.children[i] || null);
  }
  if (arrivals.length && motionEnabled()) {
    playTableSound("deal");
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
  const pass = button("패스", "pass", view.choices.canPass, "secondary");
  if (!bids.length) return `<h2>패스할 차례예요</h2><p>20점 노기루다가 최고 공약입니다.</p>${pass}`;
  let hint = "손패에서 가장 많은 무늬가 먼저 선택돼요.";
  if (view.bid) {
    hint = ui.bidSuit === "N" && view.bid.suit !== "N"
      ? `노기루다는 현재 공약과 같은 ${escapeHtml(view.bid.points)}점부터 부를 수 있어요.`
      : `${suitInfo[ui.bidSuit][1]}는 ${escapeHtml(points[0][0])}점부터 부를 수 있어요.`;
  }
  return `<h2>공약을 정하세요</h2><p>${hint}</p><div class="g-input-row">${select("기루다", "bidSuit", suits, ui.bidSuit)}${select("공약 점수", "bidPoints", points, ui.bidPoints)}</div>${button(suitInfo[ui.bidSuit][0] + " " + escapeHtml(ui.bidPoints) + "점 입찰", "bid")}${pass}`;
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
  const cards = options.filter(f => f.kind === "card").map(f => [f.card, callName(f, view.bid.suit)]);
  const hint = options.some(choice => choice.kind === "first")
    ? "카드를 부르거나 첫 트릭의 승자를 프렌드로 정할 수 있어요."
    : "함께할 사람이 가진 카드를 부르세요.";
  return `<h2>프렌드를 정하세요</h2><p>${hint} 노프렌드로 혼자 플레이할 수도 있어요.</p>${select("지정 방식", "friendKind", kinds, ui.friendKind)}${ui.friendKind === "card" ? select("프렌드 카드", "friendCard", cards, ui.friendCard) : ""}${button("프렌드 확정", "friend")}`;
}
function playControls() {
  return "<h2>카드를 내세요</h2><p>낼 수 있는 손패를 한 번 누르면 테이블에 놓입니다.</p>";
}
function specialPlaySettings(view, ui) {
  const options = view.choices.plays;
  const suits = options.filter(move => move.card === "JK" && move.suit)
    .map(move => [move.suit, suitInfo[move.suit].join(" ")]);
  const caller = options.find(move => move.jokerCall);
  const demand = suits.length ? select("조커로 선을 잡을 때 부를 무늬", "jokerSuit", suits, ui.jokerSuit) : "";
  const call = caller ? `<label class="g-call-option"><input type="checkbox" data-field="jokerCall"${ui.jokerCall ? " checked" : ""}> ${escapeHtml(suitInfo[caller.card[0]][0])}3을 낼 때 조커콜</label>` : "";
  return demand + call;
}
function playCard(ui, card) {
  if (ui.playPending || ui.view.phase !== "play" || ui.view.seat !== ui.view.turn) return;
  const moves = ui.view.choices.plays.filter(move => move.card === card);
  const useCall = ui.jokerCall && moves.some(move => move.jokerCall);
  const choice = moves.find(move => (!move.suit || move.suit === ui.jokerSuit) && Boolean(move.jokerCall) === useCall);
  if (!choice) return;
  ui.playPending = true;
  for (const el of ui.root.querySelectorAll(".g-hand-card")) el.disabled = true;
  if (ui.options.onAction({type: "play", ...choice}) === false) {
    ui.playPending = false;
    renderHand(ui, false);
  }
}
function resultControls(view, ui) {
  const result = view.result;
  return `<h2>주공 팀 ${result.won ? "승리" : "패배"}</h2>
    <p>공약은 ${escapeHtml(result.target)}점, 주공 팀은 ${escapeHtml(result.points)}점을 획득했어요.</p>
    <div class="g-result-score"><strong>${escapeHtml(result.points)}</strong><span>/ 20점</span></div>
    ${ui.options.isHost ? button("다시 한 판", "replay") : "<p>방장이 다시 한 판을 누르면 이 자리에서 다음 판이 시작됩니다.</p>"}
    ${ui.options.isHost && ui.options.onReplaySetup ? button(escapeHtml(ui.options.replaySetupLabel), "replay-setup", true, "secondary") : ""}`;
}
function previousTrick(view, nameAt) {
  const last = view.lastTrick;
  if (!last || isCoveredSeat(view, last.winner)) return "";
  return `<details class="g-log"><summary>지난 트릭 <b>${escapeHtml(nameAt(last.winner))} 승리</b></summary><p>${escapeHtml(last.number)}트릭 · ${escapeHtml(last.points)}점 획득</p><ul>${last.cards.map(m => `<li><span>${escapeHtml(nameAt(m.seat))}</span><strong>${m.card === "JK" ? "★ 조커" : suitMark(m.card[0]) + " " + escapeHtml(m.card.slice(1))}${m.card === mighty(view.bid.suit) ? " · 마이티" : ""}</strong></li>`).join("")}</ul></details>`;
}
function bidHistoryMarkup(view, nameAt) {
  const history = view.bidHistory;
  if (!history.length) return "";
  const highest = history.findLast(entry => !entry.pass);
  const entries = history.slice().reverse().map(entry => {
    const bidder = escapeHtml(entry.name ?? nameAt(entry.seat));
    return `<li${entry === highest ? ' class="g-highest-bid"' : ""}>${bidSeat(entry.seat)}<span class="g-bid-name" title="${bidder}">${bidder}</span>${entry.pass
      ? '<span class="g-bid-pass">패스</span>'
      : `<strong>${suitMark(entry.suit)} ${escapeHtml(suitInfo[entry.suit][1])} ${escapeHtml(entry.points)}점</strong>`}</li>`;
  }).join("");
  const list = `<ol aria-label="최근 입찰부터 표시">${entries}</ol>`;
  if (view.phase === "bid") return `<section class="g-bid-history"><h3>입찰 기록 <small>최근순</small></h3>${list}</section>`;
  return `<details class="g-bid-history"><summary>입찰 기록 · ${history.length}회</summary>${list}</details>`;
}
function infoMarkup(view, nameAt) {
  if (view.phase === "bid") return bidHistoryMarkup(view, nameAt);
  const rows = [];
  if (view.bid) rows.push(["공약", suitInfo[view.bid.suit].join(" ") + " · " + view.bid.points + "점"]);
  if (view.declarer != null) rows.push(["주공", nameAt(view.declarer)]);
  if (view.call) rows.push(["프렌드", view.friendKnown && view.friend == null ? "노프렌드" : (view.friend != null ? nameAt(view.friend) + " · " : "") + callName(view.call, view.bid.suit)]);
  if (view.phase === "play") rows.push(["진행", view.trickNo + " / 10 트릭"]);
  return `<dl class="g-info">${rows.map(([a, b]) => `<div><dt>${a}</dt><dd>${escapeHtml(b)}</dd></div>`).join("")}</dl>` + bidHistoryMarkup(view, nameAt);
}
function panelMarkup(view, ui, nameAt) {
  if (ui.resolving) {
    const last = ui.resolving;
    const message = isCoveredSeat(view, last.winner) ? "획득한 카드를 덮었어요."
      : last.points + "점을 가져갔어요.";
    return `<div class="g-panel-body"><div class="g-panel-caption">트릭 결과</div><div class="g-action" aria-live="polite"><h2>${escapeHtml(nameAt(last.winner))} 승리</h2><p>${escapeHtml(last.number)}번째 트릭 · ${escapeHtml(message)}</p></div>${infoMarkup(view, nameAt)}</div>${previousTrick(view, nameAt)}`;
  }
  const mine = view.seat === view.turn;
  const controls = { bid: bidControls, discard: discardControls, friend: friendControls, play: playControls, result: resultControls };
  const waiting = view.phase !== "result" && !mine;
  const content = waiting ? `<h2>${escapeHtml(nameAt(view.turn))}님 차례</h2><p>${({ bid: "입찰을 기다리고 있어요.", discard: "주공이 바닥패를 교환하고 있어요.", friend: "주공이 프렌드를 정하고 있어요.", play: "카드를 고르고 있어요." })[view.phase]}</p>` : controls[view.phase](view, ui);
  return `<div class="g-panel-body"><div class="g-panel-caption"><i class="${waiting ? "g-wait-dot" : ""}"></i>${view.phase === "result" ? "최종 결과" : mine ? "내 차례" : "상대 차례"}</div><div class="g-action" aria-live="polite">${content}</div>${infoMarkup(view, nameAt)}</div>${previousTrick(view, nameAt)}`;
}
function mountTable(root) {
  root.innerHTML = `<div class="g-screen">
    <header class="g-nav"><div class="g-nav-inner">
      <div class="g-brand"><i aria-hidden="true">♠</i><span>Mighty Club</span></div>
      <span class="g-nav-divider"></span><span class="g-nav-phase">게임 테이블</span>
      <div class="g-nav-actions"><button type="button" class="g-btn g-top g-sound" data-do="sound" aria-label="효과음">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h4l5-4v14l-5-4H3z"/><path class="g-sound-on" d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="g-sound-off" d="m16 9 5 6m0-6-5 6"/></svg><span>효과음</span>
      </button>${button("게임 규칙", "rules", true, "top")}${button("나가기", "leave", true, "top")}</div>
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
  soundControl(root.querySelector('[data-do="sound"]'));
}
function redraw(ui, newDeal = false) {
  const { view, options, root } = ui;
  const nameAt = seat => String(options.names?.[seat] ?? ((seat + 1) + "번 플레이어"));
  const focused = root.contains(document.activeElement) ? document.activeElement : null;
  const oldFocus = focused && ["card", "field", "do"].map(attr => [attr, focused.dataset[attr]]).find(([, value]) => value != null);
  const openLog = root.querySelector(".g-log")?.open;
  const openBids = root.querySelector("details.g-bid-history")?.open;
  root.querySelector("h1").textContent = view.phase === "play" ? `${view.trickNo}번째 트릭` : labels[view.phase];
  root.querySelector(".g-round-tag").textContent = view.phase === "result" ? "10트릭 완료"
    : view.phase === "bid" ? "경매 " + view.bidHistory.length + "회"
    : "기루다 · " + suitInfo[view.bid.suit].join(" ");
  // Read the departing card's position before reconciling the player's hand.
  renderTable(ui, nameAt);
  renderHand(ui, newDeal);
  if (newDeal) dealToOtherSeats(root, view.seat);
  const panel = root.querySelector(".g-panel");
  panel.innerHTML = panelMarkup(view, ui, nameAt);
  panel.classList.toggle("g-result-arrive", view.phase === "result");
  if (openLog && panel.querySelector(".g-log")) panel.querySelector(".g-log").open = true;
  if (openBids && panel.querySelector("details.g-bid-history")) panel.querySelector("details.g-bid-history").open = true;
  if (oldFocus) {
    const [attr, value] = oldFocus;
    root.querySelector(`[data-${attr}="${value}"]`)?.focus({ preventScroll: true });
  }
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
}
function bind(ui) {
  ui.root.addEventListener("animationend", event => {
    if (event.animationName === "g-send-card-back") event.target.remove();
    if (event.animationName === "g-deal-card") event.target.closest(".g-hand-card")?.classList.remove("g-deal");
    if (event.animationName === "g-play-card") {
      event.target.classList.remove("g-play-enter");
      if (motionEnabled()) playTableSound("play");
    }
  });
  ui.root.addEventListener("click", event => {
    if (!ui.root.querySelector(".g-screen")) return;
    const el = event.target.closest("button");
    if (!el || el.disabled) return;
    if (el.dataset.card) {
      const card = el.dataset.card;
      if (ui.view.phase === "discard") {
        ui.selected = ui.selected.includes(card) ? ui.selected.filter(c => c !== card) : [...ui.selected, card];
        redraw(ui);
      } else playCard(ui, card);
      return;
    }
    const kind = el.dataset.do;
    if (kind === "sound") return toggleSound(el);
    if (kind === "rules") return ui.options.onRules?.();
    if (kind === "leave") return ui.options.onLeave?.();
    if (kind === "replay") return ui.options.onReplay?.();
    if (kind === "replay-setup") return ui.options.onReplaySetup?.();
    if (kind && ui.view.seat === ui.view.turn) {
      const action = submit(ui, kind);
      if (action) ui.options.onAction(action);
    }
  });
  ui.root.addEventListener("change", event => {
    const el = event.target;
    if (!el.matches(".g-field select, .g-call-option input")) return;
    const field = el.dataset.field;
    if (field === "jokerCall") ui.jokerCall = el.checked;
    else ui[field] = ["bidPoints", "contractIndex"].includes(field) ? Number(el.value) : el.value;
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
  const covered = isCoveredSeat(ui.view, ui.resolving.winner);
  for (const [i, el] of Array.from(trick.children).entries()) {
    const face = el.firstElementChild;
    setFlightOffset(el, "collect", seat, face.getBoundingClientRect());
    el.style.setProperty("--collect-rotate", ((2 - i) * 7) + "deg");
    if (covered) {
      face.replaceChildren();
      face.classList.remove("g-mighty-play");
      face.setAttribute("aria-label", "덮은 카드");
    }
  }
  trick.classList.toggle("g-collect-covered", covered);
  trick.classList.add("g-collecting");
  playTableSound("collect");
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
  if (!container.firstElementChild) {
    mountTable(container);
    ui.centerMarkup = ui.settingsHtml = null;
  }
  ui.latest = publicView;
  ui.playPending = false;
  ui.options = options;
  if (ui.resolving) {
    // Peers can send the next lead while this client is gathering the trick.
    // Keep the newest snapshot and never dispatch actions from the held frame.
    if (!document.hidden && publicView.phase !== "bid" && publicView.lastTrick?.number === ui.resolving.number
      && publicView.friend === ui.view.friend) return;
    clearTimeout(ui.timer);
    ui.resolving = null;
  }
  const last = publicView.lastTrick;
  if (!document.hidden && last && ui.view?.phase === "play" && ui.view.trickNo === last.number && ui.view.lastTrick?.number !== last.number) {
    // Protected histories contain only the final move while a trick is being settled.
    // Animate it with the four cards this client actually saw on the felt.
    const shown = ui.view.trick;
    const cards = last.cards.length === 5 ? last.cards : last.finalPlay && shown.length === 4
      ? [...shown, last.finalPlay] : null;
    if (!cards) { displayLatest(ui); return; }
    ui.resolving = last;
    ui.view = {...publicView, phase: "play", trickNo: last.number, trick: cards, turn: null};
    updateDefaults(ui, ui.view);
    redraw(ui);
    ui.timer = setTimeout(() => collectTrick(ui), TRICK_HOLD_MS);
    return;
  }
  displayLatest(ui);
}

export function rulesContent(rules = DEFAULT_RULES) {
  const bidRange = rules.minBid === 20 ? "20점을 걸고" : `${escapeHtml(rules.minBid)}~20점 사이에서`;
  const firstFriend = rules.allowFirstFriend ? " 첫 트릭의 승자를 초구 프렌드로 지정할 수도 있습니다." : "";
  const jokerCallFrom = rules.allowFirstJokerCall ? "첫 트릭부터" : "두 번째 트릭부터";
  const jokerTiming = rules.allowLastJoker
    ? "첫 트릭에서는 조커가 가장 약하고, 조커로 시작하면 두 번째 카드가 따를 무늬를 정합니다. 2~10번째 트릭에서는 조커가 기루다를 이기며, 조커로 시작하는 사람이 따를 무늬를 부릅니다."
    : "첫 트릭과 마지막 트릭에서 조커는 가장 약합니다. 이때 조커로 시작하면 두 번째 카드가 따를 무늬를 정합니다. 2~9번째 트릭에서 조커로 시작하면 원하는 무늬를 부릅니다.";
  return `<div class="g-rules">
    <p>다섯 명이 열 번의 트릭을 플레이합니다. 주공과 프렌드는 공약한 점수를 모으고, 나머지 플레이어는 이를 막습니다.</p>
    <h3>경매와 바닥패</h3><p>조커 한 장을 포함한 53장 중 각자 10장씩 받고 3장은 바닥에 둡니다. ${bidRange} 기루다(으뜸 무늬)나 노기루다로 입찰하거나 패스하세요. 같은 점수에서는 노기루다가 무늬 공약보다 높습니다. 모두 패스하면 다시 나눕니다.</p>
    <p>경매의 승자인 주공은 바닥패를 가져와 3장을 묻습니다. 이때 기루다를 바꾸려면 공약을 2점 이상 올려야 합니다. 묻은 점수는 주공 팀의 점수입니다.</p>
    <h3>프렌드</h3><p>주공이 부른 카드를 가진 사람이 프렌드입니다. 그 카드가 나오면 모두에게 정체가 공개됩니다.${firstFriend} 노프렌드를 선택하거나 주공이 가진 카드나 묻은 카드를 부르면 혼자 플레이합니다.</p>
    <h3>카드 내기</h3><p>주공부터 한 장씩 냅니다. 선이 낸 무늬가 손에 있으면 따라야 합니다. 마이티와 조커는 무늬에 관계없이 낼 수 있습니다. 첫 트릭에서는 다른 무늬를 낼 수 있으면 기루다로 시작할 수 없습니다. 트릭을 이긴 사람이 다음 선입니다.</p>
    <h3>마이티와 조커</h3><p>가장 센 카드는 스페이드 A입니다. 스페이드가 기루다일 때는 다이아몬드 A가 마이티입니다. 그다음은 조커, 기루다, 선의 무늬 순입니다. 같은 무늬 안에서는 A가 가장 높고 2가 가장 낮습니다.</p>
    <p>${jokerTiming}</p>
    <p>${jokerCallFrom} 선이 클로버 3으로 조커콜을 선언할 수 있습니다. 조커를 가진 사람은 조커 또는 마이티를 내야 하며, 조커는 그 트릭에서 가장 약합니다. 클로버가 기루다일 때의 조커콜 카드는 스페이드 3입니다.</p>
    <h3>점수 카드와 승패</h3><p>10, J, Q, K, A는 각각 1점으로, 한 판에는 총 20점이 있습니다. 가져간 점수 카드는 보드의 각자 자리 옆에 모읍니다. 주공은 처음부터 카드를 덮고, 프렌드는 정체가 밝혀지는 즉시 앞서 가져간 카드까지 모두 덮습니다. 열 번째 트릭이 끝났을 때 주공 팀의 점수가 공약 이상이면 주공 팀이 승리합니다.</p>
  </div>`;
}
