import {newChatCredential} from './room-chat-store.js';

// Each admitted browser receives only its own succession credential. The shared
// checkpoint is the public table, scores and seating, not the players' hands.
export function hostBackups(archive, {send, checkpoint, priority, onError, grace = false}) {
  const peers = new Map();
  let closed = false, publishing = false, pending = false, graceTimer;
  let holdRoster = grace, lastError = false;
  const sorted = () => [...peers.keys()].sort((a,b) => priority(a) - priority(b));
  function share() {
    if (closed || !peers.size || !archive.term) return;
    const state = checkpoint();
    if (!state?.table) return;
    const order = sorted();
    for (const id of order) send(id,{type:'host-backup',roomId:archive.id,term:archive.term,
      self:id,credential:peers.get(id).credential,order,...state});
  }
  async function sync() {
    if (closed || holdRoster) return;
    pending = true;
    if (publishing) return publishing;
    publishing = (async () => {
      while (pending && !closed) {
        pending = false;
        try {
          await archive.setSuccessors(sorted().slice(0,128).map(id => peers.get(id)));
          lastError = false;
          share();
        } catch (error) {
          if (!closed && !lastError) onError?.(error);
          lastError = true;
        }
      }
    })();
    try { await publishing; } finally { publishing = false; }
  }
  const heartbeat = setInterval(() => { if (peers.size) void sync(); }, 9000);
  function finishGrace() {
    if (!holdRoster) return;
    clearTimeout(graceTimer);
    holdRoster = false;
    void sync();
  }
  if (grace) graceTimer = setTimeout(finishGrace, 20000);
  return {
    get size() { return peers.size; },
    include(id,accountId) {
      const existing = peers.get(id);
      if (existing && existing.accountId === (accountId || null)) return;
      peers.set(id,{accountId:accountId || null, credential:existing?.credential ?? newChatCredential()});
      if (!holdRoster) void sync();
    },
    remove(id) { if (peers.delete(id)) void sync(); },
    share, finishGrace,
    async giveToNext() {
      if (!peers.size || closed) return false;
      finishGrace();
      await sync();
      for (const id of sorted().slice(0,128)) {
        const candidate = peers.get(id);
        if (!candidate || closed) continue;
        try {
          await archive.transfer(candidate.credential);
          return true;
        } catch { /* A departure can race with the new roster. Try another admitted browser. */ }
      }
      return false;
    },
    close() { closed = true; clearInterval(heartbeat); clearTimeout(graceTimer); }
  };
}

export function validBackup(packet) {
  return packet?.type === 'host-backup' && typeof packet.roomId === 'string' &&
    /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(packet.roomId) &&
    /^[a-f\d]{64}$/.test(packet.credential) && Number.isSafeInteger(packet.term) && packet.term > 0 &&
    Array.isArray(packet.order) && packet.order.includes(packet.self) &&
    Array.isArray(packet.table?.connections) && packet.table.connections.some(([id]) => id === packet.self);
}
