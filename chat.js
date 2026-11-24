const HISTORY_LIMIT = 60;
const TEXT_LIMIT = 280;
const timeFormat = new Intl.DateTimeFormat('ko-KR', {hour: '2-digit', minute: '2-digit', hour12: false});

export function chatText(value) {
  if (typeof value !== 'string' || value.length > TEXT_LIMIT) return '';
  return value.trim();
}

function validMessage(message) {
  return message && Number.isSafeInteger(message.id) && message.id > 0 &&
    Number.isInteger(message.seat) && message.seat >= 0 && message.seat < 5 &&
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

export function setupChat(send) {
  const el = id => document.getElementById(id);
  const toggle = el('chat-toggle'), badge = el('chat-unread'), panel = el('chat-panel');
  const list = el('chat-list'), scroll = el('chat-scroll'), input = el('chat-input');
  const submit = el('chat-send'), feedback = el('chat-feedback'), empty = el('chat-empty');
  const log = new ChatLog();
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
      input.focus({preventScroll:true});
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
    name.textContent = message.name + (own ? ' · 나' : '');
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
