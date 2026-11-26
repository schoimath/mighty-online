import {chatText} from './chat.js';

const uuid = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const failedSend = '채팅을 저장하지 못했습니다. 같은 메시지를 다시 보내 주세요.';

async function scopedRequest(roomId, sender, requestId) {
  const data = new TextEncoder().encode(JSON.stringify([roomId,sender,requestId]));
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data)).slice(0,16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

// Only the current room host talks to the archive. Accepted peers, including
// unsigned spectators, receive public chat fields through their room channel.
export function createRoomChatRelay({chat, peers, sendPeer, sendHost, accountId}) {
  let current = {}, pendingSend;

  function finishPending(task, value, error) {
    if (!task) return;
    clearTimeout(task.timer);
    if (error) task.reject(new Error(error));
    else task.resolve(value);
  }
  function reset() {
    current = {};
    finishPending(pendingSend, null, failedSend);
    pendingSend = null;
  }
  function startHost(store) {
    reset();
    const room = current = {id:store.id, archive:store, writes:Promise.resolve()};
    chat.enterRoom(room.id,accountId());
    return store.open().catch(() => { if (current === room) chat.notice('채팅 저장소에 연결할 수 없습니다. 메시지를 보낼 때 다시 연결합니다.'); });
  }

  function persist(seat, name, text, peer, sender, requestId) {
    const room = current;
    if (!room.archive || !name || !chatText(text) || !uuid(requestId)) return Promise.resolve(false);
    // Serialize from receipt (including key derivation), and never duplicate a
    // message when a client retries a write whose acknowledgement was lost.
    const work = room.writes.then(async () => {
      const key = await scopedRequest(room.id,sender,requestId);
      const {replayed, ...message} = await room.archive.append({requestId:key,seat,name,text:chatText(text)});
      if (room !== current) return false;
      if (!replayed || peer === null) chat.receive(message, peer === null);
      for (const id of peers()) {
        if (!replayed || id === peer) sendPeer(id, {type:'chat-message',message,own:id === peer,
          ...(id === peer ? {requestId} : {})});
      }
      return true;
    });
    room.writes = work.catch(() => {});
    return work;
  }
  function greet(peer) {
    // Admission reveals the archive ID, never messages from before admission.
    if (current.archive) sendPeer(peer, {type:'chat-room',roomId:current.id});
  }
  function guestRoom(roomId) {
    if (!uuid(roomId)) return false;
    if (current.id && roomId !== current.id) return false;
    current.id = roomId;
    chat.enterRoom(roomId,accountId());
    return true;
  }
  function receive(packet) {
    if (packet?.type === 'chat-room') { guestRoom(packet.roomId); return true; }
    if (packet?.type === 'chat-message') {
      chat.receive(packet.message, packet.own === true);
      if (packet.own && pendingSend && pendingSend.id === packet.requestId) {
        finishPending(pendingSend,true); pendingSend=null;
      }
      return true;
    }
    if (packet?.type === 'chat-failed') {
      if (pendingSend && pendingSend.id === packet.requestId) {
        finishPending(pendingSend,null,failedSend); pendingSend=null;
      }
      return true;
    }
    // Earlier hosts broadcast their last 60 messages when someone joins.
    return packet?.type === 'chat-history';
  }
  function request(id, enqueue, error, remember) {
    return new Promise((resolve,reject) => {
      const task = {id,resolve,reject};
      task.timer = setTimeout(() => { remember(null); finishPending(task,null,error); },25000);
      remember(task);
      if (!enqueue()) { remember(null); finishPending(task,null,error); }
    });
  }
  function sendGuest(text, requestId) {
    if (!current.id) return Boolean(sendHost({type:'chat-send',text,requestId}));
    if (pendingSend) return false;
    return request(requestId,() => sendHost({type:'chat-send',text,requestId}),failedSend,task => {pendingSend=task;});
  }
  return {get id(){return current.id ?? null;},get archive(){return current.archive ?? null;},
    startHost, reset, persist, greet, receive, sendGuest};
}
