const HISTORY_LIMIT = 60;
const TEXT_LIMIT = 280;
const timeFormat = new Intl.DateTimeFormat('ko-KR', {hour: '2-digit', minute: '2-digit', hour12: false});

export function chatText(value) {
  if (typeof value !== 'string' || value.length > TEXT_LIMIT) return '';
  return value.trim();
}

function validMessage(message) {
  return message && Number.isSafeInteger(message.id) && message.id > 0 &&
    Number.isInteger(message.seat) && message.seat >= -1 && message.seat < 5 &&
    typeof message.name === 'string' && message.name.length > 0 && message.name.length <= 16 &&
    Number.isSafeInteger(message.time) && message.time >= 0 && message.time <= 8640000000000000 &&
    Boolean(chatText(message.text));
}

// A room owns one ordered log. Only its host issues message IDs.
export class ChatLog {
  constructor() { this.messages = []; }

  get lastId() { return this.messages.at(-1)?.id || 0; }

  accept(message) {
    if (!validMessage(message) || message.id <= this.lastId) return false;
    const {id, seat, name, time, text} = message;
    this.messages.push({id, seat, name, time, text: text.trim()});
    if (this.messages.length > HISTORY_LIMIT) this.messages.shift();
    return true;
  }
}

function positionChat(panel, handle, grip) {
  const heading = handle.parentElement;
  const viewport = window.visualViewport;
  const corners = [[1, 1], [0, 1], [0, 0], [1, 0]];
  const arrows = {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]};
  const sizeKey = 'mighty-chat-size';
  let size = null, resizeDrag = null, resized = false;
  let x = 1, y = 1, drag = null, dragged = false;
  let left, top, travelX, travelY;
  try {
    const saved = JSON.parse(localStorage.getItem(sizeKey));
    if (Number.isFinite(saved?.width) && saved.width >= 220 &&
        Number.isFinite(saved.height) && saved.height >= 160) size = saved;
  } catch {}

  function place(moveGrip = false) {
    panel.style.inset = `${top + y * travelY}px auto auto ${left + x * travelX}px`;
    panel.toggleAttribute('data-bottom', y > .5);
    if (moveGrip) {
      panel.toggleAttribute('data-grip-right', x < .5);
      panel.toggleAttribute('data-grip-bottom', y < .5);
    }
  }
  function layout() {
    if (panel.hidden) return;
    const width = viewport?.width ?? document.documentElement.clientWidth;
    const height = viewport?.height ?? document.documentElement.clientHeight;
    const gap = width < 600 ? 8 : 16;
    panel.style.maxWidth = Math.max(0, width - 2 * gap) + 'px';
    panel.style.maxHeight = Math.max(0, height - 2 * gap) + 'px';
    panel.style.width = size ? size.width + 'px' : '';
    panel.style.height = size ? size.height + 'px' : '';
    left = (viewport?.offsetLeft ?? 0) + gap;
    top = (viewport?.offsetTop ?? 0) + gap;
    travelX = Math.max(0, width - panel.offsetWidth - 2 * gap);
    travelY = Math.max(0, height - panel.offsetHeight - 2 * gap);
    place();
    document.documentElement.style.setProperty('--chat-height', panel.offsetHeight + 'px');
  }
  // Keep a relative position so rotation and the on-screen keyboard don't lose the panel.
  function moveTo(px, py, moveGrip = true) {
    if (travelX) x = Math.max(0, Math.min(1, (px - left) / travelX));
    if (travelY) y = Math.max(0, Math.min(1, (py - top) / travelY));
    place(moveGrip);
  }
  heading.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || event.target.closest('#chat-close')) return;
    const box = panel.getBoundingClientRect();
    const target = handle.contains(event.target) ? handle : heading;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY, left: box.left, top: box.top};
    dragged = false;
    target.setPointerCapture(event.pointerId);
  });
  heading.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    dragged = true;
    heading.classList.add('chat-dragging');
    moveTo(drag.left + dx, drag.top + dy);
  });
  heading.addEventListener('lostpointercapture', () => {
    drag = null;
    heading.classList.remove('chat-dragging');
  });
  handle.onclick = event => {
    if (event.detail && dragged) return;
    const current = corners.findIndex(([cx, cy]) => cx === Math.round(x) && cy === Math.round(y));
    [x, y] = corners[(current + 1) % corners.length];
    place(true);
  };
  handle.onkeydown = event => {
    if (event.key === 'Home') {
      x = y = 1;
      place(true);
    } else if (Object.hasOwn(arrows, event.key)) {
      const [dx, dy] = arrows[event.key], step = event.shiftKey ? 64 : 16;
      moveTo(left + x * travelX + dx * step, top + y * travelY + dy * step);
    } else return;
    event.preventDefault();
  };

  window.addEventListener('resize', layout);
  viewport?.addEventListener('resize', layout);
  viewport?.addEventListener('scroll', layout);
  if (!grip) return layout;

  function sizeFrom(box, dw, dh) {
    const growRight = panel.hasAttribute('data-grip-right');
    const growDown = panel.hasAttribute('data-grip-bottom');
    const maxWidth = growRight ? left + travelX + panel.offsetWidth - box.left : box.right - left;
    const maxHeight = growDown ? top + travelY + panel.offsetHeight - box.top : box.bottom - top;
    size = {
      width: Math.round(Math.max(220, Math.min(maxWidth, box.width + dw))),
      height: Math.round(Math.max(160, Math.min(maxHeight, box.height + dh)))
    };
    layout();
    // The corner opposite the handle stays put while the user drags.
    moveTo(growRight ? box.left : box.right - panel.offsetWidth,
      growDown ? box.top : box.bottom - panel.offsetHeight, false);
  }
  function saveSize() {
    try {
      if (size) localStorage.setItem(sizeKey, JSON.stringify(size));
      else localStorage.removeItem(sizeKey);
    } catch {}
  }
  function resetSize() {
    size = null;
    layout();
    saveSize();
  }
  grip.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0) return;
    resizeDrag = {id:event.pointerId, x:event.clientX, y:event.clientY, box:panel.getBoundingClientRect()};
    resized = false;
    grip.setPointerCapture(event.pointerId);
  };
  grip.onpointermove = event => {
    if (event.pointerId !== resizeDrag?.id) return;
    const dx = event.clientX - resizeDrag.x, dy = event.clientY - resizeDrag.y;
    if (!resized && Math.hypot(dx, dy) < 4) return;
    resized = true;
    sizeFrom(resizeDrag.box, panel.hasAttribute('data-grip-right') ? dx : -dx,
      panel.hasAttribute('data-grip-bottom') ? dy : -dy);
  };
  grip.onlostpointercapture = () => {
    resizeDrag = null;
    if (resized) saveSize();
  };
  grip.onclick = event => {
    if (event.detail && resized) return;
    if (size) return resetSize();
    sizeFrom(panel.getBoundingClientRect(), 160, 120);
    saveSize();
  };
  grip.onkeydown = event => {
    if (event.key === 'Home') resetSize();
    else if (Object.hasOwn(arrows, event.key)) {
      const [dx, dy] = arrows[event.key], step = event.shiftKey ? 64 : 16;
      sizeFrom(panel.getBoundingClientRect(), dx * step, dy * step);
      saveSize();
    } else return;
    event.preventDefault();
  };
  return layout;
}

export function setupChat(send) {
  const el = id => document.getElementById(id);
  const toggle = el('chat-toggle'), badge = el('chat-unread'), panel = el('chat-panel');
  const list = el('chat-list'), scroll = el('chat-scroll'), input = el('chat-input');
  const submit = el('chat-send'), feedback = el('chat-feedback'), empty = el('chat-empty');
  const log = new ChatLog();
  const handle = el('chat-move');
  const layout = positionChat(panel, handle, el('chat-resize'));
  let unread = 0;

  function showCount(count) {
    unread = Math.min(count, HISTORY_LIMIT);
    badge.textContent = String(unread);
    badge.hidden = !unread;
    toggle.setAttribute('aria-label', unread ? '방 채팅, 새 메시지 ' + unread + '개' : '방 채팅');
  }
  function showPanel(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      showCount(0);
      layout();
      const focusTarget = window.matchMedia('(pointer: coarse)').matches ? handle : input;
      focusTarget.focus({preventScroll:true});
      scroll.scrollTop = scroll.scrollHeight;
    } else if (toggle.isConnected && !toggle.hidden) {
      toggle.focus({preventScroll:true});
    }
  }
  toggle.onclick = () => showPanel(panel.hidden);
  el('chat-close').onclick = () => showPanel(false);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden && !document.querySelector('dialog[open]')) {
      showPanel(false);
    }
  });
  input.addEventListener('input', () => {
    submit.disabled = !chatText(input.value);
    feedback.hidden = true;
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.isComposing) event.preventDefault();
  });
  el('chat-form').onsubmit = event => {
    event.preventDefault();
    const value = chatText(input.value);
    if (!value) return;
    if (!send(value)) {
      feedback.textContent = '보내지 못했습니다. 방 연결을 확인해 주세요.';
      feedback.hidden = false;
      return;
    }
    input.value = '';
    submit.disabled = true;
    feedback.hidden = true;
    input.focus({preventScroll:true});
  };

  function receive(message, own = false, history = false) {
    if (!log.accept(message)) return false;
    const atBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 30;
    const item = document.createElement('li');
    item.className = own ? 'chat-line chat-own' : 'chat-line';
    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    const name = document.createElement('strong');
    name.textContent = message.name + (message.seat === -1 ? ' · 관전' : '') + (own ? ' · 나' : '');
    const time = document.createElement('time');
    const date = new Date(message.time);
    time.dateTime = date.toISOString();
    time.textContent = timeFormat.format(date);
    const body = document.createElement('p');
    body.textContent = message.text.trim();
    meta.append(name, time);
    item.append(meta, body);
    list.append(item);
    if (list.children.length > HISTORY_LIMIT) list.firstElementChild.remove();
    empty.hidden = true;
    if (!history && panel.hidden && !own) showCount(unread + 1);
    if (!panel.hidden && (atBottom || own)) scroll.scrollTop = scroll.scrollHeight;
    return true;
  }

  return {
    log, receive,
    restore(messages) {
      if (Array.isArray(messages)) {
        for (const message of messages.slice(-HISTORY_LIMIT)) receive(message, false, true);
      }
    },
    attach(parent) {
      if (toggle.parentNode !== parent) parent.prepend(toggle);
      toggle.hidden = false;
    },
    reset() {
      toggle.remove();
      toggle.hidden = true;
      showPanel(false);
      showCount(0);
      log.messages.length = 0;
      list.replaceChildren();
      input.value = '';
      submit.disabled = true;
      empty.hidden = false;
      feedback.hidden = true;
    }
  };
}
