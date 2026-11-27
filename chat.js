import {deviceChat} from './chat-device.js';

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
  constructor() { this.clear(); }
  clear() { this.messages = []; this.limit = HISTORY_LIMIT; }

  get lastId() { return this.messages.at(-1)?.id || 0; }

  accept(message) {
    if (!validMessage(message) || message.id <= this.lastId) return false;
    const {id, seat, name, time, text} = message;
    this.messages.push({id, seat, name, time, text: text.trim()});
    if (this.messages.length > this.limit) this.messages.shift();
    return true;
  }
  restore(messages, older) {
    const merged = new Map(this.messages.map(message => [message.id,message]));
    const oldCount = merged.size;
    for (const message of messages) {
      if (!validMessage(message) || merged.has(message.id)) continue;
      const {id,seat,name,time,text} = message;
      merged.set(id,{id,seat,name,time,text:text.trim()});
    }
    if (older) this.limit += merged.size - oldCount;
    this.messages = Array.from(merged.values()).sort((a,b) => a.id-b.id).slice(-this.limit);
  }
}

const visibleLayouts = ['horizontal','vertical','floating'];
const arrowSteps = {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]};
const bound = (value, low, high) => Math.max(low, Math.min(value, high));

function readChatSetting(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function saveChatSetting(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function resizeDockedChat(panel, grip, scroll) {
  const key = 'mighty-chat-vertical-height';
  const rootStyle = document.documentElement.style;
  let height = readChatSetting(key), drag = null;
  if (Number.isSafeInteger(height) && height > 0) rootStyle.setProperty('--chat-vertical-height',height + 'px');

  function syncRange() {
    if (grip.hidden || !panel.isConnected) return;
    const style = getComputedStyle(panel);
    const current = Math.round(panel.getBoundingClientRect().height);
    grip.setAttribute('aria-valuemin',String(Math.ceil(parseFloat(style.minHeight))));
    grip.setAttribute('aria-valuemax',String(Math.floor(parseFloat(style.maxHeight))));
    grip.setAttribute('aria-valuenow',String(current));
    grip.setAttribute('aria-valuetext',`${current}픽셀`);
  }
  function setHeight(value) {
    const atBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 30;
    if (value === null) {
      height = null;
      rootStyle.removeProperty('--chat-vertical-height');
    } else {
      height = bound(Math.round(value),Number(grip.getAttribute('aria-valuemin')),Number(grip.getAttribute('aria-valuemax')));
      rootStyle.setProperty('--chat-vertical-height',height + 'px');
    }
    if (atBottom) scroll.scrollTop = scroll.scrollHeight;
    syncRange();
  }
  grip.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || drag) return;
    syncRange();
    drag = {id:event.pointerId, y:event.clientY, height:panel.getBoundingClientRect().height};
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId || (event.clientY === drag.y && !drag.moved)) return;
    drag.moved = true;
    setHeight(drag.height + event.clientY - drag.y);
  });
  grip.addEventListener('lostpointercapture', event => {
    if (drag?.id !== event.pointerId) return;
    if (drag.moved) saveChatSetting(key,height);
    drag = null;
  });
  grip.addEventListener('keydown', event => {
    if (event.key === 'Home') {
      setHeight(null);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      syncRange();
      const step = event.shiftKey ? 64 : 16;
      setHeight(panel.getBoundingClientRect().height + (event.key === 'ArrowUp' ? -step : step));
    } else return;
    event.preventDefault();
    saveChatSetting(key,height);
  });
  new ResizeObserver(syncRange).observe(panel);
  window.addEventListener('resize',syncRange);
}

function positionFloatingChat(panel, title, grip) {
  const viewport = window.visualViewport;
  const saved = readChatSetting('mighty-chat-position');
  const savedSize = readChatSetting('mighty-chat-size');
  const fraction = value => Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
  let x = fraction(saved?.x), y = fraction(saved?.y);
  let width = Number.isFinite(savedSize?.width) && savedSize.width >= 220 ? savedSize.width : 368;
  let height = Number.isFinite(savedSize?.height) && savedSize.height >= 160 ? savedSize.height : 318;
  let gesture = null, moved = false;

  function bounds() {
    const vw = viewport?.width ?? document.documentElement.clientWidth;
    const vh = viewport?.height ?? document.documentElement.clientHeight;
    const gap = vw < 600 ? 8 : 16;
    return {left:(viewport?.offsetLeft ?? 0) + gap, top:(viewport?.offsetTop ?? 0) + gap,
      width:Math.max(1,vw - 2 * gap), height:Math.max(1,vh - 2 * gap)};
  }
  function place() {
    if (panel.hidden || panel.dataset.chatLayout !== 'floating' || !panel.isConnected) return;
    const area = bounds(), w = Math.min(width,area.width), h = Math.min(height,area.height);
    panel.style.setProperty('--chat-x',(area.left + x * (area.width - w)) + 'px');
    panel.style.setProperty('--chat-y',(area.top + y * (area.height - h)) + 'px');
    panel.style.setProperty('--chat-width',w + 'px');
    panel.style.setProperty('--chat-height',h + 'px');
    if (gesture?.handle !== grip) {
      panel.toggleAttribute('data-grip-right',x < .5);
      panel.toggleAttribute('data-grip-bottom',y < .5);
    }
  }
  function moveTo(left, top, area) {
    const dx = area.width - Math.min(width,area.width), dy = area.height - Math.min(height,area.height);
    if (dx > 0) x = bound((left - area.left) / dx,0,1);
    if (dy > 0) y = bound((top - area.top) / dy,0,1);
    place();
  }
  function resize(box, dw, dh, right, down, area) {
    const maxWidth = right ? area.left + area.width - box.left : box.right - area.left;
    const maxHeight = down ? area.top + area.height - box.top : box.bottom - area.top;
    width = bound(box.width + dw,Math.min(220,maxWidth),maxWidth);
    height = bound(box.height + dh,Math.min(160,maxHeight),maxHeight);
    moveTo(right ? box.left : box.right - width,down ? box.top : box.bottom - height,area);
  }
  function persist(resized) {
    saveChatSetting('mighty-chat-position',{x,y});
    if (resized) saveChatSetting('mighty-chat-size',{width,height});
  }
  for (const handle of [title,grip]) {
    handle.addEventListener('pointerdown', event => {
      if (panel.dataset.chatLayout !== 'floating' || !event.isPrimary || event.button !== 0 || gesture) return;
      gesture = {handle,id:event.pointerId,cx:event.clientX,cy:event.clientY,box:panel.getBoundingClientRect(),
        right:panel.hasAttribute('data-grip-right'),down:panel.hasAttribute('data-grip-bottom')};
      moved = false;
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (gesture?.id !== event.pointerId || gesture.handle !== handle) return;
      const dx = event.clientX - gesture.cx, dy = event.clientY - gesture.cy;
      if (!moved && Math.hypot(dx,dy) < 3) return;
      moved = true;
      if (handle === grip) resize(gesture.box,gesture.right ? dx : -dx,gesture.down ? dy : -dy,
        gesture.right,gesture.down,bounds());
      else moveTo(gesture.box.left + dx,gesture.box.top + dy,bounds());
    });
    handle.addEventListener('lostpointercapture', event => {
      if (gesture?.id !== event.pointerId) return;
      gesture = null;
      if (moved) persist(handle === grip);
      place();
    });
    handle.addEventListener('keydown', event => {
      if (panel.dataset.chatLayout !== 'floating') return;
      if (event.key === 'Home') {
        if (handle === grip) { width = 368; height = 318; }
        else { x = 1; y = 1; }
        place();
      } else if (Object.hasOwn(arrowSteps,event.key)) {
        const [dx,dy] = arrowSteps[event.key], step = event.shiftKey ? 64 : 16;
        const box = panel.getBoundingClientRect();
        if (handle === grip) resize(box,dx * step,dy * step,panel.hasAttribute('data-grip-right'),
          panel.hasAttribute('data-grip-bottom'),bounds());
        else moveTo(box.left + dx * step,box.top + dy * step,bounds());
      } else return;
      event.preventDefault();
      persist(handle === grip);
    });
  }
  grip.onclick = event => {
    if (event.detail && moved) return;
    width = 368; height = 318;
    place(); persist(true);
  };
  window.addEventListener('resize',place);
  viewport?.addEventListener('resize',place);
  viewport?.addEventListener('scroll',place);
  return place;
}

export function setupChat(send) {
  const el = id => document.getElementById(id);
  const toggle = el('chat-toggle'), badge = el('chat-unread'), panel = el('chat-panel');
  const list = el('chat-list'), scroll = el('chat-scroll'), input = el('chat-input');
  const submit = el('chat-send'), feedback = el('chat-feedback'), empty = el('chat-empty');
  const earlier = el('chat-older'), disclosure = el('chat-disclosure');
  const title = el('chat-title'), grip = el('chat-resize'), form = el('chat-form');
  const heightGrip = el('chat-height-grip');
  const modeButtons = Array.from(panel.querySelectorAll('[data-chat-mode]'));
  const layoutFloating = positionFloatingChat(panel,title,grip);
  resizeDockedChat(panel,heightGrip,scroll);
  const log = new ChatLog();
  const mine = new Set();
  let device = null, ownSend = null, failed = null, earlierPage = null, hasMore = false;
  let firstLiveId = null;
  function notice(text) { feedback.textContent=text; feedback.hidden=!text; }
  const preference = readChatSetting('mighty-chat-layout');
  let lastOpen = visibleLayouts.includes(preference?.lastOpen) ? preference.lastOpen : 'horizontal';
  let layout = preference?.mode === 'off' ? 'off' : lastOpen;
  let horizontalHeight = '';
  const dock = document.createElement('div');
  dock.className = 'chat-dock';
  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.className = 'chat-reopen';
  reopen.setAttribute('aria-controls',panel.id);
  reopen.textContent='방 채팅 열기';
  reopen.hidden=true;
  dock.append(reopen);
  let attached = false;
  let unread = 0;

  function showCount(count) {
    unread = Math.min(count, HISTORY_LIMIT);
    badge.textContent = String(unread);
    badge.hidden = !unread;
    reopen.textContent = unread ? '방 채팅 열기 · 새 메시지 ' + unread + '개' : '방 채팅 열기';
    toggle.setAttribute('aria-label', unread ? '방 채팅, 새 메시지 ' + unread + '개' : '방 채팅');
  }
  function showLayout(next, source) {
    const wasHidden = panel.hidden;
    const atBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 30;
    if (next !== layout) {
      // Native vertical resizing writes inline dimensions on the docked panel.
      if (layout === 'horizontal') horizontalHeight = panel.style.height;
      panel.style.removeProperty('width');
      panel.style.height = next === 'horizontal' ? horizontalHeight : '';
    }
    layout = next;
    const open = layout !== 'off', floating = layout === 'floating';
    if (open) lastOpen = layout;
    if (source) saveChatSetting('mighty-chat-layout',{mode:layout,lastOpen});
    panel.dataset.chatLayout = dock.dataset.chatLayout = layout;
    panel.hidden = !open;
    reopen.hidden = open;
    grip.hidden = !floating;
    heightGrip.hidden = layout !== 'vertical';
    if (floating) {
      title.tabIndex = 0;
      title.title = '끌거나 방향키로 이동 · Home으로 위치 초기화';
      title.setAttribute('aria-keyshortcuts','ArrowUp ArrowDown ArrowLeft ArrowRight Home');
    } else {
      title.removeAttribute('tabindex');
      title.removeAttribute('title');
      title.removeAttribute('aria-keyshortcuts');
    }
    for (const button of modeButtons) button.setAttribute('aria-pressed',String(button.dataset.chatMode === layout));
    toggle.setAttribute('aria-expanded', String(open));
    reopen.setAttribute('aria-expanded',String(open));
    if (open) {
      showCount(0);
      if (floating) layoutFloating();
      if (source && wasHidden) {
        if (!floating) panel.scrollIntoView({block:'nearest'});
        const focusTarget = window.matchMedia('(pointer: coarse)').matches ?
          modeButtons.find(button => button.dataset.chatMode === layout) : input;
        focusTarget.focus({preventScroll:true});
      }
      if (wasHidden || atBottom) scroll.scrollTop = scroll.scrollHeight;
    } else if (source) {
      (source === toggle ? toggle : reopen).focus({preventScroll:true});
    }
  }
  toggle.onclick = () => showLayout(panel.hidden ? lastOpen : 'off',toggle);
  reopen.onclick = () => showLayout(lastOpen,reopen);
  for (const button of modeButtons) button.onclick = () => showLayout(button.dataset.chatMode,button);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panel.contains(event.target) && !document.querySelector('dialog[open]')) {
      showLayout('off',panel);
    }
  });
  input.addEventListener('input', () => {
    submit.disabled = Boolean(ownSend) || !chatText(input.value);
    feedback.hidden = true;
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.isComposing) event.preventDefault();
  });
  form.onsubmit = async event => {
    event.preventDefault();
    const value = chatText(input.value);
    if (!value || ownSend) return;
    const sending = failed?.text === value ? failed : {text:value,id:crypto.randomUUID()};
    ownSend = sending;
    notice('');
    submit.disabled = true;
    submit.textContent = '보내는 중';
    try {
      if (!await send(value,sending.id)) throw new Error('방 연결을 확인한 뒤 다시 보내 주세요.');
      if (ownSend !== sending) return;
      failed = null;
      if (chatText(input.value) === value) input.value = '';
      if (document.activeElement === submit) input.focus({preventScroll:true});
    } catch {
      if (ownSend === sending) { failed=sending; notice('전송을 확인하지 못했습니다. 같은 메시지를 다시 보내 주세요.'); }
    } finally {
      if (ownSend === sending) {
        ownSend=null; submit.disabled=!chatText(input.value); submit.textContent='보내기';
      }
    }
  };

  function line(message) {
    const own = mine.has(message.id);
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
    return item;
  }
  function renderHistory() {
    const rows = log.messages.map(line);
    // Restored history precedes the local entry notice, even when a live
    // message arrives before the device finishes loading its first page.
    if (device && (firstLiveId === null || log.messages[0]?.id <= firstLiveId)) {
      const firstLiveIndex = log.messages.findIndex(message => firstLiveId !== null && message.id >= firstLiveId);
      rows.splice(firstLiveIndex < 0 ? rows.length : firstLiveIndex, 0, disclosure);
    }
    list.replaceChildren(...rows);
  }
  function receive(message, own = false) {
    if (!validMessage(message)) return false;
    const dropped = log.messages.length >= log.limit && log.messages[0];
    const appended = log.accept(message);
    if (!appended && !own) return false;
    // A retry receipt for my message can arrive after newer live messages.
    // It still belongs in this device's history with its original timestamp.
    if (!appended) log.restore([message],false);
    if (own) mine.add(message.id);
    const local = device;
    const {id,time,seat,name,text} = message;
    const row = {id,time,seat,name,text:text.trim()};
    local?.save(row,own).catch(() => {
      if (device === local) notice('이 브라우저에 채팅 기록을 저장하지 못했습니다.');
    });
    const atBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 30;
    if (appended) {
      if (firstLiveId === null) firstLiveId = id;
      list.append(line(row));
    } else renderHistory();
    if (dropped && (appended || dropped.id !== log.messages[0]?.id || id < dropped.id)) {
      if (appended) {
        if (list.firstElementChild === disclosure) disclosure.remove();
        list.firstElementChild.remove();
      }
      if (dropped.id !== log.messages[0]?.id) mine.delete(dropped.id);
      if (device) { hasMore=true; earlier.hidden=false; }
    }
    empty.hidden = true;
    if (panel.hidden && !own) showCount(unread + 1);
    if (!panel.hidden && (atBottom || own)) scroll.scrollTop = scroll.scrollHeight;
    return appended;
  }

  async function loadPage(before = null) {
    const local=device;
    if (!local || earlierPage) return;
    const task = earlierPage = {};
    earlier.disabled=true;
    try {
      const page = await local.page(before,HISTORY_LIMIT);
      if (device !== local || earlierPage !== task) return;
      const oldHeight = scroll.scrollHeight;
      const oldFirst=log.messages[0]?.id;
      for (const message of page.messages) if (message.own) mine.add(message.id);
      log.restore(page.messages,before !== null);
      renderHistory();
      hasMore=page.hasMore || (before === null && (hasMore || (page.messages[0]?.id ?? oldFirst) < log.messages[0]?.id));
      earlier.hidden=!hasMore;
      if (before !== null) scroll.scrollTop += scroll.scrollHeight-oldHeight;
      else scroll.scrollTop=scroll.scrollHeight;
    } catch {
      if (device === local) { notice('이 브라우저에서 채팅 기록을 불러오지 못했습니다.'); earlier.hidden=false; }
    } finally {
      if (earlierPage === task) { earlierPage=null; earlier.disabled=false; }
    }
  }
  earlier.onclick = () => loadPage(hasMore ? log.messages[0]?.id : null);
  function clearRoom() {
    device=null; ownSend=failed=earlierPage=null; hasMore=false;
    firstLiveId=null;
    mine.clear(); log.clear(); list.replaceChildren(); showCount(0);
    earlier.hidden=true; earlier.disabled=false; disclosure.hidden=true; empty.hidden=false;
    input.value=''; submit.textContent='보내기'; submit.disabled=true; notice('');
  }

  return {
    log, receive, notice,
    enterRoom(roomId, userId) {
      if (device?.room === roomId && device.account === (userId || 'anonymous')) return;
      clearRoom();
      device = deviceChat(roomId,userId);
      empty.hidden=true; disclosure.hidden=false; list.append(disclosure);
      void loadPage();
    },
    attach(actions, dockAfter) {
      if (actions) {
        if (toggle.parentNode !== actions) actions.prepend(toggle);
      } else if (toggle.parentNode) toggle.remove();
      toggle.hidden = !actions;
      if (dockAfter.nextElementSibling !== dock) dockAfter.after(dock);
      if (panel.parentNode !== dock) dock.prepend(panel);
      if (!attached) {
        attached = true;
        showLayout(layout);
      }
    },
    reset() {
      attached = false;
      toggle.remove();
      toggle.hidden = true;
      toggle.setAttribute('aria-expanded','false');
      panel.hidden = true;
      dock.remove();
      clearRoom();
    }
  };
}
