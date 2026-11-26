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

export function setupChat(send) {
  const el = id => document.getElementById(id);
  const toggle = el('chat-toggle'), badge = el('chat-unread'), panel = el('chat-panel');
  const list = el('chat-list'), scroll = el('chat-scroll'), input = el('chat-input');
  const submit = el('chat-send'), feedback = el('chat-feedback'), empty = el('chat-empty');
  const earlier = el('chat-older'), disclosure = el('chat-disclosure');
  const closeButton = el('chat-close'), form = el('chat-form');
  const log = new ChatLog();
  const mine = new Set();
  let device = null, ownSend = null, failed = null, earlierPage = null, hasMore = false;
  function notice(text) { feedback.textContent=text; feedback.hidden=!text; }
  // Closing chat applies only to this visit. Each new room starts with a
  // visible composer, including browsers that hid chat in an older release.
  let preferOpen = true;
  const dock = document.createElement('div');
  dock.className = 'chat-dock';
  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.className = 'chat-reopen';
  reopen.setAttribute('aria-controls',panel.id);
  reopen.textContent='방 채팅 열기';
  reopen.hidden=true;
  dock.append(reopen);
  let unread = 0;

  function showCount(count) {
    unread = Math.min(count, HISTORY_LIMIT);
    badge.textContent = String(unread);
    badge.hidden = !unread;
    reopen.textContent = unread ? '방 채팅 열기 · 새 메시지 ' + unread + '개' : '방 채팅 열기';
    toggle.setAttribute('aria-label', unread ? '방 채팅, 새 메시지 ' + unread + '개' : '방 채팅');
  }
  function showPanel(open, fromUser = false) {
    panel.hidden = !open;
    reopen.hidden = open;
    toggle.setAttribute('aria-expanded', String(open));
    if (fromUser) {
      preferOpen = open;
    }
    if (open) {
      showCount(0);
      if (fromUser) {
        panel.scrollIntoView({block:'nearest'});
        const focusTarget = window.matchMedia('(pointer: coarse)').matches ? closeButton : input;
        focusTarget.focus({preventScroll:true});
      }
      scroll.scrollTop = scroll.scrollHeight;
    } else if (fromUser && reopen.isConnected) {
      reopen.focus({preventScroll:true});
    }
  }
  toggle.onclick = () => showPanel(panel.hidden, true);
  reopen.onclick = () => showPanel(true,true);
  closeButton.onclick = () => showPanel(false, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panel.contains(event.target) && !document.querySelector('dialog[open]')) {
      showPanel(false, true);
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
    if (appended) list.append(line(row));
    else list.replaceChildren(...log.messages.map(line));
    if (dropped && (appended || dropped.id !== log.messages[0]?.id || id < dropped.id)) {
      if (appended) list.firstElementChild.remove();
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
      list.replaceChildren(...log.messages.map(line));
      empty.hidden=Boolean(log.messages.length);
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
      disclosure.hidden=false;
      void loadPage();
    },
    attach(actions, dockAfter) {
      if (toggle.parentNode !== actions) actions.prepend(toggle);
      if (dockAfter.nextElementSibling !== dock) dockAfter.after(dock);
      if (panel.parentNode !== dock) dock.prepend(panel);
      if (toggle.hidden) {
        toggle.hidden = false;
        showPanel(preferOpen);
      }
    },
    reset() {
      toggle.remove();
      toggle.hidden = true;
      preferOpen = true;
      showPanel(false);
      dock.remove();
      clearRoom();
    }
  };
}
