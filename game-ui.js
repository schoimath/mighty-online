import {handOutcome, isCoveredSeat, scoreTable, seatPile, seatStanding, settingPenaltyPile, signedScore} from "./score-ui.js";
import {DECK, DEFAULT_RULES, leadSuit, mighty} from "./engine.js";
import {VERSION} from "./release.js";
import {jokerWasPlayed, withJokerStatus} from "./table-joker.js";
import {playTableSound, soundControl, toggleSound} from "./sound.js";
import {AUCTION_BEAT_MS, FRIEND_ANNOUNCEMENT_MS, normalizeGameSpeed, paceMultiplier, tableDelay} from "./table-timing.js";
import {settlementDetails, settlements, TABLE_SCORING_VERSION} from "./table-scoring.js";
import {settlements as archivedSettlements} from "./lab/scoring.js";

const suitInfo = {
  S: ["♠", "스페이드"], H: ["♥", "하트"], D: ["♦", "다이아몬드"],
  C: ["♣", "클로버"], N: ["NT", "노기루다"],
};
const rankNames = { A: "에이스", K: "킹", Q: "퀸", J: "잭" };
const labels = { bid: "경매", discard: "카드 교환", friend: "프렌드 지정", play: "트릭 진행", result: "라운드 결과" };
const roleLabels = { declarer: "주공", friend: "프렌드", opposition: "수비" };
const chipNumber = new Intl.NumberFormat('ko-KR');
const cache = new WeakMap();
const TRICK_HOLD_MS = 810;
const COLLECT_MS = 390;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const mightyBadge = '<b class="g-mighty-tag" aria-hidden="true">마이티</b>';
const jokerCallBadge = '<b class="g-joker-call-tag" aria-hidden="true">조커콜</b>';

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
  if (!view.bid) return '<span class="g-table-symbol" aria-hidden="true">♠</span><strong>' + (view.turn === null ? '전원 패스' : '첫 입찰 대기') + '</strong>';
  const bid = view.bid;
  const latestBid = view.bidHistory.findLast(entry => !entry.pass);
  const bidder = latestBid?.name ?? nameAt(bid.seat);
  return `<div class="g-leading-bid">
    <small>${view.phase === "discard" || view.turn === null ? "낙찰 공약" : "현재 최고 공약"}</small>
    <strong aria-label="${suitInfo[bid.suit][1]} ${escapeHtml(bid.points)}점">${suitMark(bid.suit)} ${escapeHtml(bid.points)}<span>점</span></strong>
    <div class="g-bidder">${bidSeat(bid.seat)}<b title="${escapeHtml(bidder)}">${escapeHtml(bidder)}</b></div>
  </div>`;
}
function renderAuctionCalls(ui, felt, nameAt) {
  const {view} = ui;
  const calls = felt.querySelector(".g-auction-calls");
  calls.hidden = view.phase !== "bid" && view.phase !== "discard";
  if (calls.hidden) return;
  const newest = view.bidHistory.at(-1);
  const markup = Array.from({length: 5}, (_, offset) => {
    const seat = (Math.max(0, view.seat) + offset) % 5;
    const entry = view.bidHistory.findLast(call => call.seat === seat);
    if (!entry) return "";
    const name = escapeHtml(entry.name ?? nameAt(seat));
    const leader = !entry.pass && view.bid?.seat === seat;
    const value = entry.pass ? "패스" : suitMark(entry.suit) + " " + escapeHtml(entry.points);
    const label = entry.pass ? "패스" : suitInfo[entry.suit][1] + " " + escapeHtml(entry.points) + "점";
    return `<div class="g-auction-call g-played-${offset}${leader ? " g-call-leader" : ""}${entry.pass ? " g-call-pass" : ""}${entry === newest ? " g-call-new" : ""}" data-bid-seat="${seat}" aria-label="${name} · ${label}">
      <strong>${value}</strong><small>${name}</small></div>`;
  }).join("");
  if (ui.auctionMarkup !== markup) {
    calls.innerHTML = markup;
    ui.auctionMarkup = markup;
  }
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
  if (call.kind === "card") {
    if (call.card === mighty(trump)) return "마이티 프렌드";
    return call.card === "JK" ? "조커 프렌드" : cardName(call.card) + " 프렌드";
  }
  return call.kind === "first" ? "초구 프렌드" : "노프렌드";
}
function announceFriend(ui, view) {
  const banner = ui.root.querySelector(".g-friend-call");
  banner.lastElementChild.textContent = callName(view.call, view.bid.suit);
  banner.hidden = false;
  ui.friendTimer = setTimeout(() => { banner.hidden = true; }, tableDelay(FRIEND_ANNOUNCEMENT_MS, ui.options.pace));
}
function updateFriendTag(tag, view, nameAt) {
  tag.hidden = !view.call && view.phase !== "discard" && view.phase !== "friend";
  if (tag.hidden) return;
  const declaration = view.call ? callName(view.call, view.bid.suit) :
    view.phase === "friend" ? "프렌드 지정 중" : "프렌드 지정 전";
  let holder = "";
  if (view.call && view.call.kind !== "none") {
    if (view.friendKnown) holder = view.friend == null ? "노프렌드" : nameAt(view.friend);
    else if (view.seat >= 0 && view.selfRole === "friend") holder = "나";
  }
  const text = holder ? declaration + " · " + holder : declaration;
  if (tag.textContent !== text) {
    tag.textContent = text;
    tag.title = text;
  }
}
function select(label, control, options, current) {
  return `<label class="g-field"><span>${label}</span><select data-field="${control}">${options.map(([value, text]) => `<option value="${escapeHtml(value)}"${String(value) === String(current) ? " selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select></label>`;
}
function suitPicker(label, field, suits, current) {
  const options = { ...suitInfo, JK: ["★", "조커"] };
  const radios = suits.map(suit => {
    const [symbol, name] = options[suit];
    return `<label class="g-suit-option" title="${name}"><input type="radio" name="${field}" data-field="${field}" value="${suit}" aria-label="${name}"${suit === current ? " checked" : ""}><span aria-hidden="true" class="g-suit g-suit-${suit}">${symbol}</span></label>`;
  }).join("");
  return `<fieldset class="g-suit-picker"><legend>${label} <strong>${options[current][1]}</strong></legend><div class="g-suit-options">${radios}</div></fieldset>`;
}
function button(label, name, enabled = true, style = "primary") {
  return `<button type="button" class="g-btn g-${style}" data-do="${name}"${enabled ? "" : " disabled"}>${label}</button>`;
}
function updateDefaults(ui, view) {
  const signature = [view.phase, view.seat, view.turn, view.dealNo, view.trickNo, view.hand.join("."), view.bid?.points, view.bid?.suit].join("|");
  if (ui.signature === signature) return;
  const claimDialog = ui.root.querySelector(".g-claim-dialog");
  if (claimDialog?.open) claimDialog.close();
  ui.signature = signature;
  ui.selected = [];
  ui.pendingCard = null;
  const bids = view.choices.bids || [];
  ui.bidSuit = longestSuit(view.hand, [...new Set(bids.map(bid => bid.suit))]);
  ui.bidPoints = bids.find(bid => bid.suit === ui.bidSuit)?.points;
  ui.contractIndex = Math.max(0, (view.choices.contracts || []).findIndex(c => c.points === view.bid?.points && c.suit === view.bid?.suit));
  ui.contractPointsBySuit = new Map();
  const friends = view.choices.friends || [];
  if (friends.length) {
    const trump = view.bid.suit;
    const own = new Set([...view.hand, ...view.discarded]);
    const candidates = [mighty(trump), "JK"];
    if (trump !== "N") candidates.push(trump + "A");
    const preferred = candidates.find(card => !own.has(card));
    ui.friendKind = preferred ? "card" : "none";
    // Keep a valid card ready if the declarer switches back from no-friend.
    const available = friends.filter(f => f.kind === "card" && !own.has(f.card));
    ui.friendCard = preferred ?? (available.find(f => f.card.endsWith("A")) ?? available[0]).card;
  }
}
function visibleRole(view, seat) {
  if (view.declarer === seat) return "declarer";
  if ((view.friendKnown && view.friend === seat) || (view.seat === seat && view.selfRole === "friend")) return "friend";
  return view.phase === "result" ? "opposition" : "";
}
function roleAt(view, seat) {
  const role = visibleRole(view, seat);
  if (role === "friend" && view.call?.kind === "card" && view.call.card === mighty(view.bid.suit)) return "마이티 프렌드";
  return roleLabels[role] || "";
}
function balanceText(value) {
  return Number.isSafeInteger(value) ? `${chipNumber.format(value)}칩` : '';
}

export function updateSeatBalances(container, seatBalances) {
  const ui = cache.get(container);
  if (!ui?.options) return;
  ui.options = {...ui.options, seatBalances};
  if (ui.resolving && ui.latest.phase === 'result') return;
  for (const badge of container.querySelectorAll('[data-chip-seat]')) {
    const text = balanceText(seatBalances?.[Number(badge.dataset.chipSeat)]);
    if (badge.lastElementChild.textContent !== text) badge.lastElementChild.textContent = text;
    badge.hidden = !text;
  }
}

function nameAtSeat(ui, seat) {
  return String(ui.options.names?.[seat] ?? ((seat + 1) + "번 플레이어"));
}

function seatMarkup(ui, nameAt) {
  const {view, options, resolving} = ui;
  const beforeSettlement = resolving && ui.latest.phase === "result";
  const balances = beforeSettlement ? resolving.previousBalances : options.seatBalances;
  return Array.from({ length: 5 }, (_, offset) => {
    const seat = (Math.max(0, view.seat) + offset) % 5, name = nameAt(seat);
    const model = options.modelLabels?.[seat];
    const isTurn = view.turn === seat && view.phase !== "result";
    const role = roleAt(view, seat);
    const playing = view.phase === "play" || view.phase === "result";
    const inAuction = view.phase === "bid";
    const details = role || (playing || inAuction ? "" : escapeHtml(view.counts[seat]) + "장");
    const status = [isTurn ? "차례" : "", details].filter(Boolean).join(" · ");
    const leader = inAuction && view.bid?.seat === seat;
    const avatar = inAuction ? seat + 1 : Array.from(name.trim().replace(/^AI\s+/i, ""))[0] || "♠";
    const standing = seatStanding(options.scoreboard, seat, beforeSettlement);
    const balance = balanceText(balances?.[seat]);
    const chips = `<span class="g-seat-balance" data-chip-seat="${seat}"${balance ? '' : ' hidden'}><span class="visually-hidden">보유 칩 </span><span>${balance}</span></span>`;
    const header = `<span class="g-avatar g-avatar-${seat}" aria-label="${seat + 1}번 자리">${escapeHtml(avatar)}</span><span class="g-seat-tag"><span class="g-seat-identity"><span class="g-seat-name">${escapeHtml(name)}${seat === view.seat ? '<small>나</small>' : ""}</span>${standing}</span>${chips}<span class="g-seat-detail">${isTurn ? '<i></i>' : ""}${status}</span></span>`;
    return `<div class="g-seat g-seat-${offset} ${isTurn ? "g-seat-active" : ""} ${leader ? "g-seat-bidder" : ""} ${resolving?.winner === seat ? "g-trick-winner" : ""}" data-seat="${seat}" data-seat-role="${visibleRole(view, seat)}" role="group" aria-label="${escapeHtml(name)} 자리${model ? ' · ' + escapeHtml(model) : ''}"${model ? ' title="' + escapeHtml(model) + '"' : ""}><div class="g-seat-head">${header}</div>${seatPile(view, seat)}</div>`;
  }).join("");
}
function setFlightOffset(element, prefix, from, to) {
  const x = from.left + from.width / 2 - to.left - to.width / 2;
  const y = from.top + from.height / 2 - to.top - to.height / 2;
  element.style.setProperty("--" + prefix + "-x", x + "px");
  element.style.setProperty("--" + prefix + "-y", y + "px");
  return Math.hypot(x, y);
}

function dealToOtherSeats(root, localSeat) {
  const felt = root.querySelector(".g-felt");
  felt.querySelectorAll(".g-flight-back").forEach(card => card.remove());
  if (!motionEnabled()) return;
  const deck = felt.getBoundingClientRect();
  for (let offset = localSeat < 0 ? 0 : 1; offset < 5; offset++) {
    const destination = felt.querySelector(`[data-seat="${(Math.max(0, localSeat) + offset) % 5}"]`).getBoundingClientRect();
    const card = document.createElement("i");
    card.className = "g-flight-back";
    card.setAttribute("aria-hidden", "true");
    setFlightOffset(card, "flight", destination, deck);
    card.style.setProperty("--deal-delay", (offset * 65) + "ms");
    felt.append(card);
  }
}

function roundSweep(view, options) {
  if (view.phase !== "result") return null;
  if (!options.scoreboard && !options.resumed) {
    // The original host awards a backrun for a ten-point contract shortfall.
    const {won, target, points} = view.result;
    if (won && points === 20) return "run";
    if (!won && target - points >= 10) return "backrun";
    return null;
  }
  const {bonuses} = settlementDetails(view.result, view.bid.suit);
  if (bonuses.includes("런")) return "run";
  if (bonuses.includes("백런")) return "backrun";
  return null;
}

function sweepMarkup(kind, points) {
  const run = kind === "run";
  return `<div class="g-sweep g-sweep-${kind}" role="status">
    <i class="g-sweep-crest" aria-hidden="true"></i>
    <strong class="g-sweep-title">${run ? "런" : "백런"}</strong>
    <small>${run ? "여당" : "야당"} ${escapeHtml(run ? points : 20 - points)}점</small>
  </div>`;
}

function emptyTableMarkup(ui, nameAt) {
  const {view} = ui;
  if (view.phase === "result") {
    const outcome = (ui.sweep ? sweepMarkup(ui.sweep, view.result.points) : "") + settingLineMarkup(view);
    if (outcome) return outcome;
  }
  if (view.phase === "bid" || view.phase === "discard") return leadingBidMarkup(view, nameAt);
  if (view.phase === "play" && view.trickNo < 10 && view.hand.length > 1 && view.seat === view.declarer && view.turn === view.seat && view.choices.canDeclareSetting === undefined) {
    return '<div class="g-setting-compat"><strong>이 방은 세팅 선언을 지원하지 않아요</strong><small>이번 판이 끝나면 방장이 게임을 새로고침하고 새 방을 열어 주세요.</small></div>';
  }
  let label = view.phase === "play" ? "첫 카드를 기다리는 중" : labels[view.phase];
  if (view.claimPending || ui.claimSubmitting) label = "세팅 판정 중";
  else if (view.settingAwaitingFriend) label = "초구 프렌드 결정";
  else if (view.phase === "play" && view.seat === view.turn) label = "첫 카드를 내세요";
  else if (view.phase === "result" && view.result.setting) label = view.result.setting.success ? "세팅 성공" : "세팅 실패";
  return `<span class="g-table-symbol" aria-hidden="true">♠</span><strong>${escapeHtml(label)}</strong>`;
}

function renderTable(ui, nameAt) {
  const {view, root, resolving} = ui;
  const felt = root.querySelector(".g-felt");
  felt.dataset.phase = view.phase;
  felt.querySelector(".g-seats").innerHTML = seatMarkup(ui, nameAt);
  renderAuctionCalls(ui, felt, nameAt);
  const caption = felt.querySelector(".g-trick-result");
  caption.hidden = !resolving;
  if (resolving) {
    caption.firstElementChild.textContent = nameAt(resolving.winner);
    caption.lastElementChild.textContent = isCoveredSeat(view, resolving.winner) ? "트릭 승리" : resolving.points + "점 획득";
  }
  renderTrick(ui, nameAt);
}

function renderTrick(ui, nameAt) {
  const {view, root, playPending} = ui;
  const felt = root.querySelector(".g-felt");
  const moves = playPending ? [...view.trick, playPending.move] : view.trick;
  const trick = felt.querySelector(".g-trick");
  const center = felt.querySelector(".g-table-center");
  center.hidden = moves.length > 0;
  trick.hidden = !moves.length;
  if (trick.hidden || trick.dataset.number !== String(view.trickNo)) {
    trick.replaceChildren();
    felt.querySelector(".g-call-announcement").textContent = "";
    trick.classList.remove("g-collecting", "g-collect-covered");
    trick.dataset.number = String(view.trickNo);
  }
  if (!center.hidden) {
    const markup = emptyTableMarkup(ui, nameAt);
    if (ui.centerMarkup !== markup) {
      center.innerHTML = markup;
      ui.centerMarkup = markup;
    }
    return;
  }
  // Keep the clicked card mounted when its authoritative move arrives. A rejected
  // play (or another choice made in a second tab) only replaces the differing suffix.
  const moveKey = move => [move.seat, move.card, move.suit || '', Boolean(move.jokerCall)].join('/');
  let kept = 0;
  while (kept < moves.length && trick.children[kept]?.dataset.move === moveKey(moves[kept])) kept++;
  while (trick.children.length > kept) trick.lastElementChild.remove();
  if (!moves[0].jokerCall) felt.querySelector(".g-call-announcement").textContent = "";
  const lead = leadSuit(moves);
  for (const move of moves.slice(kept)) {
    const offset = (move.seat - Math.max(0, view.seat) + 5) % 5;
    const isMighty = move.card === mighty(view.bid.suit);
    const called = move.jokerCall && (!view.jokerPlayed || moves.some(play => play.card === "JK"));
    const ruff = move.card[0] === view.bid.suit && lead !== view.bid.suit;
    const label = nameAt(move.seat) + " · " + cardName(move.card) + (called ? " · 조커콜" : isMighty ? " · 마이티" : "");
    const caption = move.suit ? suitMark(move.suit) + " 요구" : escapeHtml(nameAt(move.seat));
    const effect = called ? " g-joker-call-play" : isMighty ? " g-mighty-play" : "";
    const badge = called ? jokerCallBadge : isMighty ? mightyBadge : "";
    trick.insertAdjacentHTML("beforeend", `<div class="g-played g-played-${offset}" data-play-seat="${move.seat}"><div class="g-on-table${effect}" role="img" aria-label="${escapeHtml(label)}">${cardFace(move.card)}${badge}</div><span class="g-play-label">${caption}</span></div>`);
    trick.lastElementChild.dataset.move = moveKey(move);
    const face = trick.lastElementChild.firstElementChild;
    if (called) {
      felt.querySelector(".g-call-announcement").textContent = label;
      face.dataset.landingSound = "jokerCall";
    } else if (ruff) face.dataset.landingSound = "ruff";
    if (!motionEnabled()) {
      if (face.dataset.landingSound) playTableSound(face.dataset.landingSound);
      continue;
    }
    const ownCard = move.seat === view.seat && root.querySelector(`.g-hand-card[data-card="${move.card}"]`);
    const source = ownCard || felt.querySelector(`[data-seat="${move.seat}"]`);
    const distance = setFlightOffset(face, "play", source.getBoundingClientRect(), face.getBoundingClientRect());
    face.style.setProperty("--play-time", Math.min(285, Math.round(170 + distance * .26)) + "ms");
    face.style.setProperty("--play-scale", ownCard ? ownCard.offsetWidth / face.offsetWidth : .94);
    face.style.setProperty("--play-rotate", [0, -6, -3, 3, 6][offset] + "deg");
    face.classList.add("g-play-enter");
  }
}

function canDeclareSetting(ui) {
  const {view} = ui;
  return view.phase === "play" && view.trickNo < 10 && view.hand.length > 1 && view.seat === view.turn && view.choices.canDeclareSetting &&
    !ui.resolving && !ui.playPending && !ui.claimSubmitting && !view.claimPending;
}

function renderHand(ui, newDeal) {
  const {view, root} = ui;
  const hand = root.querySelector(".g-hand");
  const shortcut = root.querySelector(".g-choice-shortcut");
  hand.hidden = view.seat < 0 || view.phase === "result";
  if (view.seat < 0 && hand.firstChild) hand.replaceChildren();
  if (hand.hidden) { shortcut.hidden = true; return; }
  let row = hand.querySelector(".g-cards");
  if (!row) {
    ui.decisionHtml = null;
    hand.setAttribute("aria-label", "내 손패");
    hand.innerHTML = '<div class="g-section-heading"><h2>내 손패 <span></span></h2><div class="g-hand-actions"><span class="g-role"></span><button type="button" class="g-btn g-claim-open" data-do="claim" aria-haspopup="dialog" hidden>세팅 선언</button></div></div><div class="g-cards"></div><section id="g-hand-decision" class="g-decision g-action" aria-label="내 차례 선택" hidden></section><div class="g-play-settings" hidden></div>';
    row = hand.querySelector(".g-cards");
    ui.decisionObserver?.disconnect();
    ui.decisionInView = false;
    ui.decisionObserver = new IntersectionObserver(([entry]) => {
      if (!entry.target.isConnected) return;
      ui.decisionInView = entry.intersectionRatio >= .99;
      shortcut.hidden = hand.hidden || entry.target.hidden || ui.decisionInView;
    }, {threshold:[0, .99]});
    ui.decisionObserver.observe(hand.querySelector(".g-decision"));
  }
  const cards = ui.playPending ? view.hand.filter(card => card !== ui.playPending.move.card) : view.hand;
  hand.querySelector("h2 span").textContent = cards.length + "장";
  const role = hand.querySelector(".g-role");
  hand.dataset.seatRole = visibleRole(view, view.seat);
  role.textContent = roleAt(view, view.seat) || roleLabels[view.selfRole] || "";
  role.hidden = !role.textContent;
  hand.querySelector('[data-do="claim"]').hidden = !canDeclareSetting(ui);
  const decision = hand.querySelector(".g-decision");
  const choices = {bid:bidControls, discard:discardControls, friend:friendControls};
  const markup = view.turn === view.seat && choices[view.phase] ? choices[view.phase](view, ui) : "";
  if (markup !== ui.decisionHtml) decision.innerHTML = markup;
  ui.decisionHtml = markup;
  decision.hidden = !markup;
  shortcut.hidden = !markup || ui.decisionInView;
  if (markup) shortcut.textContent = {bid:"공약 선택 ↓", discard:"묻을 패 선택 ↓", friend:"프렌드 선택 ↓"}[view.phase];
  if (newDeal) row.replaceChildren();
  const existing = new Map(Array.from(row.children, el => [el.dataset.card, el]));
  for (const [card, el] of existing) if (!cards.includes(card)) el.remove();
  const interactive = view.turn === view.seat && !ui.playPending && !ui.claimSubmitting && !view.claimPending &&
    (view.phase === "discard" || view.phase === "play");
  const settings = hand.querySelector(".g-play-settings");
  const settingsHtml = interactive && view.phase === "play" ? specialPlaySettings(view, ui) : "";
  if (settingsHtml !== ui.settingsHtml) {
    settings.innerHTML = settingsHtml;
    ui.settingsHtml = settingsHtml;
  }
  settings.hidden = !settingsHtml;
  let trump = view.bid?.suit;
  if (view.phase === "bid" && view.turn === view.seat) trump = ui.bidSuit ?? trump;
  if (view.phase === "discard") trump = view.choices.contracts?.[ui.contractIndex]?.suit ?? trump;
  const mightyCard = trump && mighty(trump);
  const jokerCallCard = trump && (trump === "C" ? "S3" : "C3");
  const orderedHand = view.phase !== "bid" && trump && trump !== "N"
    ? [...cards.filter(card => card[0] === trump), ...cards.filter(card => card[0] !== trump)]
    : cards;
  const incoming = new Set(view.incomingCards);
  const arrivals = [];
  for (const [i, card] of orderedHand.entries()) {
    const isMighty = card === mightyCard;
    const isJokerCall = card === jokerCallCard && !view.jokerPlayed;
    const isIncoming = incoming.has(card);
    let label = cardName(card);
    if (isMighty) label += " · 마이티";
    if (isJokerCall) label += " · 조커콜 카드";
    if ((isMighty || isJokerCall) && (view.phase === "bid" || view.phase === "discard")) label += " (현재 기루다 기준)";
    if (isIncoming) label += " · 바닥에서 받은 패";
    const moves = view.choices.plays.filter(move => move.card === card);
    if (moves.length > 1) label += card === "JK" ? " · 요구 무늬 선택" : " · 선언 여부 선택";
    let el = existing.get(card);
    if (!el) {
      el = document.createElement("button");
      el.type = "button";
      el.className = "g-hand-card";
      el.dataset.card = card;
      if (newDeal || view.phase === "discard") arrivals.push(el);
    }
    if (!el.firstElementChild || el.classList.contains("g-hand-mighty") !== isMighty ||
        el.classList.contains("g-hand-joker-call") !== isJokerCall ||
        el.classList.contains("g-hand-incoming") !== isIncoming) {
      el.classList.toggle("g-hand-mighty", isMighty);
      el.classList.toggle("g-hand-joker-call", isJokerCall);
      el.classList.toggle("g-hand-incoming", isIncoming);
      const badge = isMighty ? mightyBadge : isJokerCall ? jokerCallBadge : "";
      el.innerHTML = cardFace(card) + badge +
        (isIncoming ? '<b class="g-incoming-tag" aria-hidden="true">바닥</b>' : "");
    }
    const selected = ui.selected.includes(card);
    const allowed = interactive && (view.phase === "discard" ? (selected || ui.selected.length < 3) : moves.length > 0);
    el.classList.toggle("g-selected", selected);
    el.classList.toggle("g-illegal", interactive && !allowed);
    el.disabled = !allowed;
    el.title = label;
    el.setAttribute("aria-label", label);
    if (view.phase === "discard") el.setAttribute("aria-pressed", String(selected));
    else el.removeAttribute("aria-pressed");
    if (interactive && moves.length > 1) el.setAttribute("aria-expanded", String(ui.pendingCard === card));
    else el.removeAttribute("aria-expanded");
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
  const suits = [...new Set(bids.map(b => b.suit))];
  const points = bids.filter(b => b.suit === ui.bidSuit).map(b => [b.points, b.points + "점"]);
  const pass = button("패스", "pass", view.choices.canPass, "secondary");
  if (!bids.length) return `<h2>패스할 차례예요</h2><p>20점 노기루다가 최고 공약입니다.</p><div class="g-bid-actions">${pass}</div>`;
  let hint = "손패에서 가장 많은 무늬가 먼저 선택돼요.";
  if (view.bid) {
    hint = ui.bidSuit === "N" && view.bid.suit !== "N"
      ? `노기루다는 현재 공약과 같은 ${escapeHtml(view.bid.points)}점부터 부를 수 있어요.`
      : `${suitInfo[ui.bidSuit][1]}는 ${escapeHtml(points[0][0])}점부터 부를 수 있어요.`;
  }
  return `<h2>공약을 정하세요</h2><p>${hint}</p>${suitPicker("기루다","bidSuit",suits,ui.bidSuit)}${select("공약 점수", "bidPoints", points, ui.bidPoints)}
    <div class="g-bid-actions">${button(suitMark(ui.bidSuit) + " " + escapeHtml(ui.bidPoints) + "점 입찰", "bid")}${pass}</div>`;
}
function discardControls(view, ui) {
  const contracts = view.choices.contracts || [];
  let revise = "";
  if (contracts.length > 1) {
    const current = contracts[ui.contractIndex];
    const suits = [...new Set(contracts.map(c => c.suit))];
    const points = contracts.flatMap((c,i) => c.suit === current.suit ? [[i,c.points + "점"]] : []);
    revise = suitPicker("최종 기루다","contractSuit",suits,current.suit) + select("최종 공약 점수","contractIndex",points,ui.contractIndex);
  }
  return `<h2>묻을 카드 3장을 고르세요</h2><p>바닥패를 합친 13장 중 3장을 고르세요. 묻은 점수는 주공 팀이 가져갑니다.</p>${revise}${button(`3장 묻기 · ${ui.selected.length}/3`, "discard", ui.selected.length === 3)}`;
}
const friendSuit = card => card === "JK" ? "JK" : card[0];
function friendControls(view, ui) {
  const options = view.choices.friends || [];
  const labelsByKind = { card: "카드로 지정", first: "초구 프렌드", none: "노프렌드" };
  const kinds = [...new Set(options.map(f => f.kind))].map(kind => [kind, labelsByKind[kind]]);
  let cardControls = "";
  if (ui.friendKind === "card") {
    const current = friendSuit(ui.friendCard);
    const cards = options.filter(f => f.kind === "card");
    const suits = [...new Set(cards.map(f => friendSuit(f.card)))];
    const ranks = cards.filter(f => friendSuit(f.card) === current).map(f => {
      const rank = f.card.slice(1);
      const name = f.card === "JK" || f.card === mighty(view.bid.suit) ? callName(f, view.bid.suit) : (rankNames[rank] || rank);
      return [f.card,name];
    });
    cardControls = suitPicker("프렌드 무늬","friendSuit",suits,current) + select("프렌드 카드","friendCard",ranks,ui.friendCard);
  }
  const hint = ui.friendKind === "none" ? "주공 혼자 공약에 도전해요." : options.some(choice => choice.kind === "first")
    ? "카드를 부르거나 첫 트릭의 승자를 프렌드로 정할 수 있어요."
    : "함께할 사람이 가진 카드를 부르세요.";
  const solo = ui.friendKind === "card" && (view.hand.includes(ui.friendCard) || view.discarded.includes(ui.friendCard));
  return `<h2>프렌드를 정하세요</h2><p>${solo ? "내 손에 있거나 묻은 카드를 부르면 노프렌드로 진행해요." : hint}</p>${select("지정 방식", "friendKind", kinds, ui.friendKind)}${cardControls}${button("프렌드 확정", "friend")}`;
}
function specialPlaySettings(view, ui) {
  if (!ui.pendingCard) return "";
  const options = view.choices.plays.filter(move => move.card === ui.pendingCard);
  if (options.length < 2) return "";
  const suits = options.map(move => move.suit).filter(Boolean);
  const control = suits.length ? suitPicker("조커로 요구할 무늬", "jokerSuit", suits, ui.jokerSuit)
    : `<label class="g-call-option"><input type="checkbox" data-field="jokerCall"${ui.jokerCall ? " checked" : ""}> <span>${suitMark(ui.pendingCard[0])}3 조커콜</span></label>`;
  return control + `<div class="g-play-buttons">${button("취소", "cancel-play", true, "secondary")}${button("카드 내기", "confirm-play")}</div>`;
}
function cancelPlay(ui) {
  const card = ui.pendingCard;
  if (!card) return;
  ui.pendingCard = null;
  renderHand(ui, false);
  ui.root.querySelector(`.g-hand-card[data-card="${card}"]`)?.focus({preventScroll:true});
}
function playCard(ui, card, confirmed = false) {
  if (ui.playPending || ui.claimSubmitting || ui.view.claimPending || ui.view.phase !== "play" || ui.view.seat !== ui.view.turn) return;
  const moves = ui.view.choices.plays.filter(move => move.card === card);
  if (!moves.length) return;
  if (moves.length > 1 && !confirmed) {
    if (ui.pendingCard !== card) {
      ui.pendingCard = card;
      const suits = moves.map(move => move.suit).filter(Boolean);
      const trump = ui.view.bid.suit;
      ui.jokerSuit = suits.includes(trump) ? trump : longestSuit(ui.view.hand, suits);
      ui.jokerCall = moves.some(move => move.jokerCall);
      renderHand(ui, false);
    }
    ui.root.querySelector(".g-play-settings input:checked, .g-play-settings input[type=checkbox]")?.focus({preventScroll:true});
    return;
  }
  const choice = moves.length === 1 ? moves[0] : moves.find(move =>
    (!move.suit || move.suit === ui.jokerSuit) && Boolean(move.jokerCall) === ui.jokerCall);
  if (!choice) return;
  const pending = {dealNo:ui.view.dealNo, trickNo:ui.view.trickNo, move:{seat:ui.view.seat, ...choice}};
  ui.playPending = pending;
  ui.pendingCard = null;
  // Measure the source while its hand button is still on screen.
  renderTrick(ui, seat => nameAtSeat(ui, seat));
  renderHand(ui, false);
  function rollback() {
    if (ui.playPending !== pending) return;
    ui.playPending = null;
    if (confirmed) ui.pendingCard = card;
    renderTrick(ui, seat => nameAtSeat(ui, seat));
    renderHand(ui, false);
    const retry = confirmed ? '[data-do="confirm-play"]' : `.g-hand-card[data-card="${card}"]`;
    ui.root.querySelector(retry)?.focus({preventScroll:true});
  }
  try {
    const result = ui.options.onAction({type:"play", ...choice});
    if (result === false) rollback();
    else if (result?.then) result.then(accepted => { if (accepted === false) rollback(); }, rollback);
  } catch (error) {
    rollback();
    throw error;
  }
}

function claimClick(ui, kind) {
  const dialog = ui.root.querySelector(".g-claim-dialog");
  if (kind === "claim") {
    if (!canDeclareSetting(ui) || dialog.open) return;
    dialog.querySelector(".g-claim-count").textContent = ui.view.hand.length;
    dialog.showModal();
    dialog.querySelector('[data-do="cancel-claim"]').focus();
    return;
  }
  if (!dialog.open) return;
  dialog.close();
  if (kind !== "confirm-claim" || !canDeclareSetting(ui)) return;

  ui.claimSubmitting = true;
  ui.pendingCard = null;
  redraw(ui);
  if (ui.options.onAction({type:"claim"}) === false) {
    ui.claimSubmitting = false;
    redraw(ui);
    ui.root.querySelector('[data-do="claim"]')?.focus({preventScroll:true});
  }
}

function settingLineMarkup(view) {
  const setting = view.result?.setting;
  const line = setting?.line;
  if (view.phase !== "result" || !setting?.success || !Array.isArray(line) || !line.length ||
      line.length !== setting.remainingTricks || !line.every(move => DECK.includes(move?.card))) return "";
  const firstTrick = 11 - line.length;
  const cards = line.map((move, index) => {
    const isMighty = move.card === mighty(view.bid.suit);
    const faceClass = isMighty ? " g-hand-mighty" : move.jokerCall ? " g-hand-joker-call" : "";
    let note = isMighty ? "마이티" : move.jokerCall ? "조커콜" : "";
    if (move.suit && Object.hasOwn(suitInfo, move.suit)) {
      note = `<span role="img" aria-label="${suitInfo[move.suit][1]}">${suitMark(move.suit)}</span> 요구`;
    }
    return `<li><small>${firstTrick + index}트릭</small>
      <span class="g-setting-card${faceClass}" role="img" aria-label="${cardName(move.card)}">${cardFace(move.card)}</span>
      ${note ? `<small class="g-setting-note">${note}</small>` : ""}</li>`;
  }).join("");
  return `<section class="g-setting-line" aria-label="주공의 세팅 카드 순서"><h2>세팅 성공</h2>
    <ol start="${firstTrick}" style="--setting-columns:${Math.min(5, line.length)}">${cards}</ol></section>`;
}

function nextRoundControls(options) {
  const {isHost, nextRound} = options;
  if (!nextRound) return isHost ? button("다시 한 판", "replay") : "<p>방장이 다음 판을 시작할 때까지 기다려 주세요.</p>";
  if (nextRound.status === "starting") return "<p>다음 판을 준비하고 있습니다.</p>";
  if (nextRound.status === "manual") return isHost
    ? "<p>다음 판을 자동으로 시작하지 못했습니다.</p>" + button("다음 판 다시 시작", "replay")
    : "<p>방장이 다음 판을 다시 시작할 때까지 기다려 주세요.</p>";
  const countdown = '<p class="g-next-round" data-next-countdown role="timer" aria-live="off"></p>';
  if (!isHost) return countdown;
  return countdown + button("지금 시작", "replay") +
    button(nextRound.status === "paused" ? "자동 진행 재개" : "잠시 멈춤", "toggle-next-round", true, "secondary");
}

function updateNextCountdown(ui) {
  clearTimeout(ui.countdownTimer);
  const node = ui.root.querySelector("[data-next-countdown]");
  const next = ui.options.nextRound;
  if (!node || !next) return;
  const paused = next.status === "paused";
  const remaining = Math.max(0, paused ? next.remainingMs : next.deadline - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  node.textContent = paused ? `자동 진행 일시정지 · 남은 시간 ${seconds}초` :
    seconds > 0 ? `${seconds}초 후 다음 판이 시작됩니다.` : "다음 판을 준비하고 있습니다.";
  if (!paused && seconds > 0) {
    ui.countdownTimer = setTimeout(() => updateNextCountdown(ui), remaining - (seconds - 1) * 1000);
  }
}

function updateTurnCountdown(ui) {
  clearTimeout(ui.turnTimer);
  const clock = ui.root.querySelector(".g-turn-clock");
  const deadline = ui.options.turnDeadline;
  clock.hidden = !Number.isFinite(deadline) || ui.view.turn == null || ui.view.phase === "result";
  if (clock.hidden) return;
  const remaining = Math.max(0, deadline - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  clock.textContent = seconds ? `AI 선택까지 ${seconds}초` : "AI 선택 중";
  clock.classList.toggle("g-turn-ending", seconds <= 3);
  if (seconds) ui.turnTimer = setTimeout(() => updateTurnCountdown(ui), remaining - (seconds - 1) * 1000);
}

function resultControls(view, ui) {
  const result = view.result;
  const setting = result.setting;
  const recipient = setting?.success ? "주공이" : "야당이";
  const claimResult = setting ? `<div class="g-claim-outcome" data-success="${Boolean(setting.success)}">
    <strong>세팅 ${setting.success ? "성공" : "실패"}</strong>
    <p>남은 ${escapeHtml(setting.remainingTricks)}개 트릭에 ${setting.remainingPoints
      ? `걸린 ${escapeHtml(setting.remainingPoints)}점을 ${recipient} 가져갔어요.` : "점수 카드가 없었어요."}</p>${settingPenaltyPile(view)}</div>` : "";
  const board = ui.options.scoreboard;
  const chipDelta = ui.options.chipDelta;
  const seat = ui.options.settlementSeat ?? view.seat;
  const outcome = handOutcome(result, seat);
  const handDeltas = ui.options.handDeltas;
  const hasServerScores = Array.isArray(handDeltas) && handDeltas.length === 5 && handDeltas.every(Number.isSafeInteger);
  const currentRules = board?.scoringVersion === TABLE_SCORING_VERSION || ui.options.resumed || hasServerScores;
  let net = chipDelta;
  if (outcome.role && net == null) {
    if (hasServerScores) net = handDeltas[seat];
    else if (currentRules) net = settlements(result, view.bid.suit)[seat];
    else if (board) net = board.members.find(m => m.seat === seat)?.lastDelta;
    else net = archivedSettlements(result, view.bid.suit)[seat];
  }
  let breakdown = "";
  if (currentRules) {
    const {base, bonuses, unit} = settlementDetails(result, view.bid.suit);
    const factors = bonuses.map(name => {
      const label = name === "노기루다" ? '<abbr title="노기루다">NT</abbr>' : name;
      return `<span class="g-factor">×2 <small>(${label})</small></span>`;
    });
    const equation = bonuses.length
      ? `<span>${signedScore(base)}점</span> ${factors.join(" ")} <strong>= ${signedScore(unit)}점</strong>`
      : `<strong>${signedScore(unit)}점</strong>`;
    breakdown = `<div class="g-settlement-formula"><span>여당 기준점수</span><div class="g-equation">${equation}</div></div>`;
  }
  const role = outcome.role === '주공' ? (result.friend == null ? '주공 ×4' : '주공 ×2') : outcome.role;
  const roleLabel = role ? `<small>내 역할 · ${role}</small>` : "";
  const payout = Number.isSafeInteger(net) ? `<div class="g-result-score g-my-settlement" data-sign="${Math.sign(net)}">
    <span>${chipDelta == null ? "내 정산" : "내 칩 증감"}</span><strong>${signedScore(net)}</strong><span>${chipDelta == null ? "점" : "칩"}</span></div>` : "";
  let next = "";
  if (ui.options.departing) next = '<p role="status">나가기 예약에 따라 잠시 후 로비로 돌아갑니다.</p>';
  else if (!ui.options.resumed) {
    if (!board?.complete) next = nextRoundControls(ui.options);
    if (ui.options.isHost && ui.options.onReplaySetup) {
      next += button(escapeHtml(ui.options.replaySetupLabel), "replay-setup", ui.options.nextRound?.status !== "starting", board?.complete ? "primary" : "secondary");
    }
  }
  let standings = board;
  if (!standings) {
    const deltas = hasServerScores ? handDeltas : (currentRules ? settlements : archivedSettlements)(result,view.bid.suit);
    standings = {members:deltas.map((lastDelta,seat)=>({seat,name:nameAtSeat(ui,seat),lastDelta}))};
  }
  const table = board?.complete ? "" : scoreTable(standings,seat,{roundResult:true,title:"플레이어 성적"});
  return `<div class="g-outcome-heading"${outcome.role ? ` data-won="${outcome.won}"` : ""}><h2>${outcome.title}</h2>${roleLabel}</div>
    ${next ? `<div class="g-result-actions">${next}</div>` : ""}
    ${payout}<p>공약 ${escapeHtml(result.target)}점 ${result.won ? "달성" : "실패"} · 여당 ${escapeHtml(result.points)}점 · 야당 ${20 - result.points}점</p>
    ${claimResult}${breakdown}${table}`;
}
function previousTrick(view, nameAt) {
  const last = view.lastTrick;
  if (!last || isCoveredSeat(view, last.winner)) return "";
  return `<section class="g-log"><h3>지난 트릭</h3><p>${escapeHtml(last.number)}트릭 · ${escapeHtml(nameAt(last.winner))} 승리 · ${escapeHtml(last.points)}점 획득</p><ul>${last.cards.map(m => `<li><span>${escapeHtml(nameAt(m.seat))}</span><strong>${m.card === "JK" ? "★ 조커" : suitMark(m.card[0]) + " " + escapeHtml(m.card.slice(1))}${m.card === mighty(view.bid.suit) ? " · 마이티" : ""}</strong></li>`).join("")}</ul></section>`;
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
  return `<section class="g-bid-history"><h3>입찰 기록 <small>최근순</small></h3>${list}</section>`;
}
function renderRecords(ui) {
  const {view, options, root} = ui;
  const nameAt = seat => nameAtSeat(ui, seat);
  const markup = previousTrick(view, nameAt) + bidHistoryMarkup(view, nameAt) + scoreTable(options.scoreboard, options.settlementSeat ?? view.seat);
  if (markup === ui.recordsHtml) return;
  root.querySelector(".g-records-body").innerHTML = markup || "<p>아직 기록된 입찰이나 트릭이 없습니다.</p>";
  ui.recordsHtml = markup;
}

function tableNotice(view, ui) {
  if (view.claimPending || ui.claimSubmitting) return "세팅 판정 중입니다.";
  if (view.settingAwaitingFriend) return "세팅 실패 · 초구 프렌드를 정하기 위해 첫 트릭을 진행합니다.";
  if (view.phase === "bid" && view.misdealCount) return "파토 · 점수 카드가 없는 손패가 있어 다시 나눴습니다.";
  return "";
}
function mountTable(root) {
  root.innerHTML = `<div class="g-screen">
    <header class="g-nav"><div class="g-nav-inner">
      <div class="g-brand"><i aria-hidden="true">♠</i><span>Mighty Club</span></div>
      <span class="g-nav-divider"></span><span class="g-nav-phase">게임 테이블</span>
      <nav class="g-nav-links" aria-label="게임 안내">
        <button type="button" class="g-btn g-top" data-do="rules" aria-haspopup="dialog" aria-controls="modal">게임 규칙</button>
      </nav>
      <div class="g-nav-actions"><button type="button" class="g-btn g-top g-sound" data-do="sound" aria-label="효과음">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h4l5-4v14l-5-4H3z"/><path class="g-sound-on" d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="g-sound-off" d="m16 9 5 6m0-6-5 6"/></svg><span>효과음</span>
      </button>${button("나가기", "leave", true, "top")}</div>
    </div></header>
    <div class="g-main">
      <div class="g-heading"><div class="g-eyebrow"><i aria-hidden="true">♠</i> 마이티 · 5인전
        <span class="g-match-progress" hidden></span><small class="g-release-note">v${VERSION}</small>
        <button type="button" class="g-records-open" data-do="records" aria-haspopup="dialog" aria-controls="g-records-dialog">대국 기록</button></div>
        <div class="g-title-row"><div class="g-title-context"><h1></h1><div class="g-round-tags"><span class="g-round-tag"></span><span class="g-friend-tag" aria-live="polite" aria-atomic="true" hidden></span></div></div>
          <label class="g-pace"><span>진행 속도</span>
            <select data-table-pace><option value="slow">느리게</option><option value="normal">보통</option><option value="fast">빠르게</option></select>
            <strong class="g-pace-value" hidden></strong></label></div></div>
      <div class="g-layout">
        <section class="g-board" aria-label="게임 테이블"><span class="g-turn-clock" role="timer" aria-live="off" hidden></span><div class="g-felt"><div class="g-felt-line"></div>
          <div class="g-table-center"></div><div class="g-auction-calls" hidden></div><div class="g-trick" hidden></div><div class="g-seats"></div>
          <div class="g-friend-call" role="status" aria-atomic="true" hidden><small>프렌드 선언</small><strong></strong></div>
          <span class="g-call-announcement" role="status" aria-atomic="true"></span>
          <p class="g-trick-result" hidden><span></span><b></b></p></div>
          <button type="button" class="g-choice-shortcut" data-do="jump-choice" aria-controls="g-hand-decision" hidden></button></section>
        <p class="g-table-notice" role="status" hidden></p>
        <section class="g-hand"></section>
        <section class="g-round-result g-action" aria-label="이번 판 결과" hidden></section>
        <section class="g-match-final" aria-label="경기 최종 결과" hidden></section>
      </div>
      <section class="g-public-audience public-audience" hidden></section>
    </div>
    <dialog id="g-records-dialog" class="modal g-records-dialog" aria-labelledby="g-records-title">
      <div class="modal-inner"><h2 id="g-records-title">대국 기록</h2>
        <button type="button" class="close-icon" data-do="close-records" aria-label="대국 기록 닫기">×</button>
        <div class="g-records-body"></div></div></dialog>
    <dialog class="modal g-claim-dialog" aria-labelledby="g-claim-title" aria-describedby="g-claim-description g-claim-warning">
      <div class="modal-inner"><h2 id="g-claim-title">세팅을 선언할까요?</h2>
        <p id="g-claim-description">다른 사람이 어떤 카드를 내도 남은 <b class="g-claim-count"></b>개 트릭을 주공 혼자 모두 딸 수 있어야 합니다.</p>
        <p id="g-claim-warning"><strong>실패하면 남은 점수 카드는 모두 야당이 가져갑니다.</strong></p>
        <div class="room-actions"><button type="button" class="plain-button" data-do="cancel-claim" autofocus>취소</button><button type="button" class="primary-button" data-do="confirm-claim">세팅 선언하기</button></div>
      </div></dialog></div>`;
  soundControl(root.querySelector('[data-do="sound"]'));
}

function paintPace(ui) {
  const {pace, pendingPace, onPaceChange} = ui.options;
  const control = ui.root.querySelector('[data-table-pace]');
  const value = ui.root.querySelector('.g-pace-value');
  const editable = typeof onPaceChange === 'function';
  const waiting = editable && pendingPace != null;
  const selected = normalizeGameSpeed(waiting ? pendingPace : pace);
  if (control.value !== selected) control.value = selected;
  control.hidden = !editable;
  control.disabled = !editable || waiting;
  control.setAttribute('aria-busy', String(waiting));
  value.hidden = editable;
  if (!editable) value.textContent = control.selectedOptions[0].textContent;
  ui.root.firstElementChild.style.setProperty('--table-pace', paceMultiplier(pace));
}

export function updateGamePace(container, pace, pendingPace = null) {
  const ui = cache.get(container);
  if (!ui?.options || !container.firstElementChild) return;
  ui.options = {...ui.options, pace, pendingPace};
  paintPace(ui);
}

function redraw(ui, newDeal = false) {
  const { view, options, root } = ui;
  updateTurnCountdown(ui);
  root.querySelector(".g-nav-phase").textContent = view.seat < 0 ? "테이블 관전" : "게임 테이블";
  const leaveButton = root.querySelector('[data-do="leave"]');
  leaveButton.textContent = options.departing ? "나가기 예약 중" : "나가기";
  const nameAt = seat => nameAtSeat(ui, seat);
  const focused = root.contains(document.activeElement) ? document.activeElement : null;
  const oldFocus = focused && ["card", "field", "do"].map(attr => [attr, focused.dataset[attr]]).find(([, value]) => value != null);
  const board = options.scoreboard;
  const finished = view.phase === "result" && board?.complete;
  root.querySelector("h1").textContent = finished ? `${board.rounds}판 경기 종료`
    : view.phase === "play" ? `${view.trickNo}번째 트릭` : labels[view.phase];
  const progress = root.querySelector(".g-match-progress");
  progress.hidden = !board?.roundLimit || finished;
  if (!progress.hidden) {
    const settled = view.phase === "result" || (ui.resolving && ui.latest.phase === "result");
    const current = board.rounds + (settled ? 0 : 1);
    progress.textContent = `${current} / ${board.roundLimit}판`;
    progress.setAttribute("aria-label", `총 ${board.roundLimit}판 중 ${current}번째 판`);
  }
  const final = root.querySelector(".g-match-final");
  if (finished) {
    const summary = scoreTable(board, options.settlementSeat ?? view.seat, {final:true, title:"최종 순위"});
    if (ui.finalHtml !== summary) final.innerHTML = summary;
    ui.finalHtml = summary;
  } else if (!final.hidden) {
    final.replaceChildren();
    ui.finalHtml = null;
  }
  final.hidden = !finished;
  const tag = root.querySelector(".g-round-tag");
  const showContract = view.phase !== "bid" && view.phase !== "result";
  tag.classList.toggle("g-contract-tag", showContract);
  if (showContract) {
    const {suit, points} = view.bid;
    tag.innerHTML = `<span class="g-contract-prefix">공약 </span>${suitMark(suit)} ${suitInfo[suit][1]} <strong>${escapeHtml(points)}점</strong>`;
  } else if (finished) {
    tag.textContent = handOutcome(view.result, options.settlementSeat ?? view.seat).title;
  } else {
    tag.textContent = view.phase === "result" ? (view.result.setting ? "세팅 종료" : "10트릭 완료") : "경매 " + view.bidHistory.length + "회";
  }
  updateFriendTag(root.querySelector(".g-friend-tag"), view, nameAt);
  // Read the departing card's position before reconciling the player's hand.
  renderTable(ui, nameAt);
  renderHand(ui, newDeal);
  const claimDialog = root.querySelector(".g-claim-dialog");
  if (claimDialog.open && !canDeclareSetting(ui)) claimDialog.close();
  if (newDeal) dealToOtherSeats(root, view.seat);
  const notice = root.querySelector(".g-table-notice");
  const message = tableNotice(view, ui);
  if (notice.textContent !== message) notice.textContent = message;
  notice.hidden = !message;
  const result = root.querySelector(".g-round-result");
  const resultHtml = view.phase === "result" ? resultControls(view, ui) : "";
  if (resultHtml !== ui.resultHtml) result.innerHTML = resultHtml;
  ui.resultHtml = resultHtml;
  result.hidden = !resultHtml;
  result.classList.toggle("g-result-arrive", !result.hidden);
  if (root.querySelector(".g-records-dialog").open) renderRecords(ui);
  updateNextCountdown(ui);
  if (oldFocus && document.activeElement !== focused) {
    const [attr, value] = oldFocus;
    const radio = focused.type === "radio" ? `[value="${focused.value}"]` : "";
    root.querySelector(`[data-${attr}="${value}"]${radio}`)?.focus({ preventScroll: true });
  }
  if (view.phase !== "result") ui.resultWasShown = false;
  else if (!ui.resultWasShown && options.onResultShown) {
    ui.resultWasShown = true;
    options.onResultShown();
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
      if (motionEnabled()) playTableSound(event.target.dataset.landingSound || "play");
    }
  });
  ui.root.addEventListener("animationcancel", event => {
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
        redraw(ui);
      } else playCard(ui, card);
      return;
    }
    const kind = el.dataset.do;
    if (kind === "claim" || kind === "cancel-claim" || kind === "confirm-claim") return claimClick(ui, kind);
    if (kind === "cancel-play") return cancelPlay(ui);
    if (kind === "confirm-play") return playCard(ui, ui.pendingCard, true);
    if (kind === "sound") return toggleSound(el);
    if (kind === "jump-choice") {
      const hand = ui.root.querySelector(".g-hand");
      const choice = hand.querySelector(".g-decision");
      if (!choice || choice.hidden || hand.hidden) return;
      const target = ui.view.phase === "discard" ? hand.querySelector(".g-hand-card:enabled")
        : choice.querySelector("select, input:checked, button:enabled");
      hand.scrollIntoView({block:"start"});
      target?.focus({preventScroll:true});
      return;
    }
    if (kind === "records") {
      renderRecords(ui);
      return ui.root.querySelector(".g-records-dialog").showModal();
    }
    if (kind === "close-records") return ui.root.querySelector(".g-records-dialog").close();
    if (kind === "rules") return ui.options.onRules?.();
    if (kind === "leave") return ui.options.onLeave?.();
    if (kind === "replay") return ui.options.onReplay?.();
    if (kind === "toggle-next-round") return ui.options.onToggleNextRound?.();
    if (kind === "replay-setup") return ui.options.onReplaySetup?.();
    if (kind && ui.view.seat === ui.view.turn) {
      const action = submit(ui, kind);
      if (action) ui.options.onAction(action);
    }
  });
  ui.root.addEventListener("keydown", event => {
    if (event.key === "Escape" && ui.pendingCard && event.target.closest(".g-hand")) {
      event.preventDefault();
      cancelPlay(ui);
    }
  });
  ui.root.addEventListener("change", event => {
    const el = event.target;
    if (el.matches('[data-table-pace]')) {
      if (!el.disabled && ui.options.onPaceChange) ui.options.onPaceChange(el.value);
      return;
    }
    if (!el.matches(".g-field select, .g-call-option input, .g-suit-option input")) return;
    const field = el.dataset.field;
    if (field === "contractSuit") {
      const contracts = ui.view.choices.contracts;
      const current = contracts[ui.contractIndex];
      ui.contractPointsBySuit.set(current.suit, current.points);
      const points = ui.contractPointsBySuit.get(el.value) ?? current.points;
      const exact = contracts.findIndex(c => c.suit === el.value && c.points === points);
      ui.contractIndex = exact >= 0 ? exact : contracts.findIndex(c => c.suit === el.value);
    } else if (field === "friendSuit") {
      const available = ui.view.choices.friends.filter(f => f.kind === "card" && friendSuit(f.card) === el.value);
      const rank = ui.friendCard === "JK" ? "A" : ui.friendCard.slice(1);
      ui.friendCard = (available.find(f => f.card === el.value + rank) || available[0]).card;
    } else if (field === "jokerCall") ui.jokerCall = el.checked;
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
  if (previous?.phase === "bid" && previous.turn !== null) {
    const allPassed = view.phase === "bid" && view.dealNo === previous.dealNo + 1 &&
      !previous.bid && previous.bidHistory.length === 4 && previous.bidHistory.every(entry => entry.pass);
    let announcement;
    if (previous.dealNo === view.dealNo && view.bidHistory.length > previous.bidHistory.length) {
      announcement = view.bidHistory.at(-1);
    } else if (allPassed) {
      // The engine replaces the history as soon as the fifth player passes.
      announcement = {seat: previous.turn, pass: true};
    }
    if (announcement) {
      playTableSound(announcement.pass ? "pass" : "bid", announcement);
      if (!document.hidden && (view.phase === "discard" || allPassed)) {
        // Finish showing the auction before displaying the kitty or the next deal.
        ui.view = {...previous, turn: null, bid: allPassed ? null : view.bid,
          bidHistory: allPassed ? [...previous.bidHistory, announcement] : view.bidHistory};
        redraw(ui);
        ui.auctionTimer = setTimeout(() => {
          ui.auctionTimer = null;
          displayLatest(ui);
        }, tableDelay(AUCTION_BEAT_MS, ui.options.pace));
        return;
      }
    }
  }
  if (view.phase === "play" && view.trickNo === 1 && view.call && !view.claimPending && !view.settingAwaitingFriend && previous?.phase !== "play") {
    announceFriend(ui, view);
  } else if (view.phase !== "play" || view.claimPending || view.settingAwaitingFriend) {
    clearTimeout(ui.friendTimer);
    ui.root.querySelector(".g-friend-call").hidden = true;
  }
  ui.sweep = roundSweep(view, ui.options);
  if (ui.sweep && previous && previous.phase !== "result") playTableSound(ui.sweep);
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
      face.classList.remove("g-mighty-play", "g-joker-call-play");
      face.setAttribute("aria-label", "덮은 카드");
    }
  }
  trick.classList.toggle("g-collect-covered", covered);
  if (covered) ui.root.querySelector(".g-call-announcement").textContent = "";
  trick.classList.add("g-collecting");
  playTableSound("collect");
  ui.timer = setTimeout(() => finishCollection(ui), tableDelay(COLLECT_MS, ui.options.pace));
}

export function clearGame(container) {
  const ui = cache.get(container);
  if (!ui) return;
  clearTimeout(ui.timer);
  clearTimeout(ui.auctionTimer);
  clearTimeout(ui.friendTimer);
  clearTimeout(ui.countdownTimer);
  clearTimeout(ui.turnTimer);
  ui.decisionObserver?.disconnect();
  ui.auctionTimer = null;
  ui.resultWasShown = false;
  ui.view = ui.latest = ui.resolving = ui.signature = ui.playPending = null;
  container.replaceChildren();
}

// Older hosts report the visible cards but do not remember the Joker for guests.
function withRememberedJoker(view, previous) {
  if (view.jokerPlayed !== undefined || view.phase !== "play") return view;
  const sameDeal = previous?.phase === "play" && previous.dealNo === view.dealNo && previous.trickNo <= view.trickNo;
  return withJokerStatus(view, (sameDeal && previous.jokerPlayed) || jokerWasPlayed(view));
}

function hasSettingDeclaration(view) {
  return view.claimPending || view.settingAwaitingFriend || view.result?.setting;
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
    ui.auctionMarkup = ui.centerMarkup = ui.settingsHtml = ui.finalHtml = ui.recordsHtml = ui.resultHtml = null;
  }
  publicView = withRememberedJoker(publicView, ui.latest);
  if (ui.latest && !hasSettingDeclaration(ui.latest) && hasSettingDeclaration(publicView)) {
    playTableSound("setting");
  }
  ui.latest = publicView;
  const pending = ui.playPending;
  if (pending) {
    const sameTurn = publicView.phase === "play" && !publicView.claimPending &&
      publicView.dealNo === pending.dealNo && publicView.trickNo === pending.trickNo &&
      publicView.seat === pending.move.seat && publicView.turn === pending.move.seat;
    const canStillPlay = sameTurn && publicView.choices.plays.some(move =>
      move.card === pending.move.card && move.suit === pending.move.suit && Boolean(move.jokerCall) === Boolean(pending.move.jokerCall));
    if (!canStillPlay) ui.playPending = null;
  }
  ui.claimSubmitting = false;
  const previousBalances = ui.options?.seatBalances;
  ui.options = options;
  paintPace(ui);
  // A failed opening claim may play one trick solely to identify the friend.
  // Its point cards are awarded by the claim, not to that trick's winner.
  if (publicView.phase === "result" && publicView.result.setting) {
    clearTimeout(ui.timer);
    ui.resolving = null;
    displayLatest(ui);
    return;
  }
  if (ui.auctionTimer) {
    redraw(ui);
    return;
  }
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
    ui.resolving = {...last, previousBalances};
    ui.view = {...publicView, phase: "play", trickNo: last.number, trick: cards, turn: null};
    updateDefaults(ui, ui.view);
    redraw(ui);
    ui.timer = setTimeout(() => collectTrick(ui), tableDelay(TRICK_HOLD_MS, options.pace));
    return;
  }
  displayLatest(ui);
}

export function rulesContent(rules = DEFAULT_RULES, scoringVersion = TABLE_SCORING_VERSION) {
  const bidRange = rules.minBid === 20 ? "20점을 걸고" : `${escapeHtml(rules.minBid)}~20점 사이에서`;
  const firstFriend = rules.allowFirstFriend ? " 첫 트릭의 승자를 초구 프렌드로 지정할 수도 있습니다." : "";
  const jokerCallFrom = rules.allowFirstJokerCall ? "첫 트릭부터" : "두 번째 트릭부터";
  const hasStandings = scoringVersion !== 'ten-base-v1';
  const opening = hasStandings ? " 처음 받은 10장에 점수 카드(10·J·Q·K·A)가 한 장도 없는 사람이 있으면 파토입니다. 공약 전에 모두 다시 받고 같은 자리부터 시작합니다." : "";
  const contractRule = scoringVersion === TABLE_SCORING_VERSION
    ? "여당이 공약에 성공하면 기본점수는 2 × (최종 공약 − 13) + (여당 득점 − 최종 공약)입니다. 실패하면 모자란 점수만큼 잃습니다. 15점 공약에서 17점이면 +6점, 14점이면 −1점입니다."
    : "이 방에서는 최종 공약에서 10을 뺀 값을 한 몫으로 정해 성공하면 더하고 실패하면 뺍니다.";
  const scoring = hasStandings
    ? contractRule + " 런(여당 20점), 백런(야당 10점 이상), 노기루다, 노프렌드는 각각 2배이며 겹치면 곱합니다. 새 테이블에서는 모두 0점으로 시작하며 개인 점수는 판마다 누적됩니다."
    : "여당이 성공하면 획득 점수에서 10을 뺀 값, 실패하면 공약에 모자란 값으로 정산합니다. 런(여당 20점), 백런(공약보다 10점 이상 부족), 노기루다, 노프렌드는 각각 2배입니다.";
  const jokerTiming = rules.allowLastJoker
    ? "첫 트릭에서는 조커가 가장 약하고, 조커로 시작하면 두 번째 카드가 따를 무늬를 정합니다. 2~10번째 트릭에서는 조커가 기루다를 이기며, 조커로 시작하는 사람이 따를 무늬를 부릅니다."
    : "첫 트릭과 마지막 트릭에서 조커는 가장 약합니다. 이때 조커로 시작하면 두 번째 카드가 따를 무늬를 정합니다. 2~9번째 트릭에서 조커로 시작하면 원하는 무늬를 부릅니다.";
  return `<div class="g-rules">
    <p>다섯 명이 열 번의 트릭을 플레이합니다. 주공과 프렌드는 공약한 점수를 모으고, 나머지 플레이어는 이를 막습니다.</p>
    <h3>경매와 바닥패</h3><p>조커 한 장을 포함한 53장 중 각자 10장씩 받고 3장은 바닥에 둡니다. 첫 판은 1번 자리부터, 다음 판은 직전 판 프렌드부터 입찰합니다. 노프렌드였다면 직전 주공부터 시작합니다. ${bidRange} 기루다(으뜸 무늬)나 노기루다로 입찰하거나 패스하세요. 같은 점수에서는 노기루다가 무늬 공약보다 높습니다. 모두 패스하면 다시 나눕니다.</p>
    <p>${opening} 경매의 승자인 주공은 바닥패를 가져와 3장을 묻습니다. 이때 기루다를 바꾸려면 공약을 2점 이상 올려야 합니다. 묻은 점수는 주공 팀의 점수입니다.</p>
    <h3>프렌드</h3><p>주공이 부른 카드를 가진 사람이 프렌드입니다. 기본 선택은 마이티, 조커, 기루다 A 순서이며 주공이 들고 있거나 묻은 카드는 건너뜁니다. 셋 다 주공에게 있으면 노프렌드가 기본입니다. 노기루다에서는 마이티와 조커가 모두 주공에게 있으면 노프렌드입니다. 부른 카드가 나오면 모두에게 정체가 공개됩니다.${firstFriend} 노프렌드를 선택하거나 주공이 가진 카드나 묻은 카드를 부르면 혼자 플레이합니다.</p>
    <h3>카드 내기</h3><p>주공부터 한 장씩 냅니다. 선이 낸 무늬가 손에 있으면 따라야 합니다. 마이티와 조커는 무늬에 관계없이 낼 수 있습니다. 첫 트릭에서는 다른 무늬를 낼 수 있으면 기루다로 시작할 수 없습니다. 트릭을 이긴 사람이 다음 선입니다.</p>
    <h3>세팅</h3><p>주공은 1~9트릭에 선을 잡으면 카드를 내기 전에 세팅을 선언할 수 있습니다. 마지막 트릭에는 각자 남은 카드를 냅니다. 다른 네 사람이 어떤 합법적인 카드를 내더라도 주공 혼자 남은 트릭을 모두 딸 수 있으면 성공입니다. 성공하면 남은 점수 카드는 주공이 가져가고, 주공이 낼 수 있는 카드 순서를 보드 중앙에 공개합니다. 실패하면 남은 점수 카드는 모두 야당 몫입니다. 이미 획득한 점수와 묻은 카드는 원래대로 정산합니다. 초구 프렌드를 부르고 첫 트릭 전에 세팅에 실패하면, 프렌드를 정하기 위해 첫 트릭만 진행한 뒤 정산합니다.</p>
    <h3>마이티와 조커</h3><p>가장 센 카드는 스페이드 A입니다. 스페이드가 기루다일 때는 다이아몬드 A가 마이티입니다. 그다음은 조커, 기루다, 선의 무늬 순입니다. 같은 무늬 안에서는 A가 가장 높고 2가 가장 낮습니다.</p>
    <p>${jokerTiming}</p>
    <p>${jokerCallFrom} 선이 클로버 3으로 조커콜을 선언할 수 있습니다. 조커를 가진 사람은 조커 또는 마이티를 내야 하며, 조커는 그 트릭에서 가장 약합니다. 클로버가 기루다일 때의 조커콜 카드는 스페이드 3입니다. 조커가 한 번 나오면 손패의 조커콜 표식이 사라지고 그 카드는 일반 3으로 냅니다.</p>
    <h3>점수 카드와 승패</h3><p>10, J, Q, K, A는 각각 1점으로, 한 판에는 총 20점이 있습니다. 가져간 점수 카드는 보드의 각자 자리 옆에 모읍니다. 주공은 처음부터 카드를 덮고, 프렌드는 정체가 밝혀지는 즉시 앞서 가져간 카드까지 모두 덮습니다. 열 번째 트릭이 끝났을 때 주공 팀의 점수가 공약 이상이면 주공 팀이 승리합니다.</p>
    <p>${scoring} 배율을 모두 곱한 값이 여당 기준점수입니다. 프렌드는 그 점수 그대로, 주공은 2배, 야당은 각각 부호를 바꿔 정산합니다. 노프렌드 주공은 4배입니다.</p>
  </div>`;
}
