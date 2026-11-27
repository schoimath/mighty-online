const topic = 'realtime:mighty-public-directory';
const joinRef = '1';
const joinTimeout = 10000;
const heartbeatInterval = 25000;

// The public channel sends wake-ups only. All displayed data comes from the directory RPC.
export function subscribeDirectoryEvents(client, {onChange, onStatus}) {
  if (typeof globalThis.WebSocket !== 'function' || !client.url || !client.publishableKey) return () => {};

  const url = new URL(client.url.replace(/\/$/, '') + '/realtime/v1/websocket');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('apikey', client.publishableKey);
  url.searchParams.set('vsn', '1.0.0');

  let socket, deadline, heartbeat, retry;
  let connected = null, stopped = false, retryDelay = 2000;
  function disconnect() {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
      socket = null;
    }
    const wasConnected = connected;
    connected = false;
    if (stopped) return;
    retry = setTimeout(connect, retryDelay + Math.random() * 500);
    retryDelay = Math.min(retryDelay * 2, 30000);
    if (wasConnected !== false) onStatus(false);
  }

  function connect() {
    try {
      socket = new WebSocket(url);
    } catch {
      queueMicrotask(() => { if (!stopped) disconnect(); });
      return;
    }
    let ref = 1, pendingHeartbeat = null;
    function send(packet) {
      try { socket.send(JSON.stringify(packet)); } catch { disconnect(); }
    }
    deadline = setTimeout(disconnect, joinTimeout);
    socket.onclose = socket.onerror = disconnect;
    socket.onopen = () => send({
      topic, event:'phx_join', ref:joinRef, join_ref:joinRef,
      payload:{config:{broadcast:{ack:false,self:false},presence:{enabled:false},private:false}}
    });
    socket.onmessage = ({data}) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message?.topic === 'phoenix' && message.event === 'phx_reply' && message.ref === pendingHeartbeat) {
        if (message.payload?.status === 'ok') pendingHeartbeat = null;
        return;
      }
      if (message?.topic !== topic) return;
      const {event, payload} = message;
      if (event === 'phx_close' || event === 'phx_error' || (event === 'system' && payload?.status === 'error')) {
        disconnect();
        return;
      }
      if (!connected && event === 'phx_reply' && message.ref === joinRef) {
        if (payload?.status !== 'ok') { disconnect(); return; }
        clearTimeout(deadline);
        connected = true;
        retryDelay = 2000;
        heartbeat = setInterval(() => {
          if (pendingHeartbeat !== null) { disconnect(); return; }
          pendingHeartbeat = String(++ref);
          send({topic:'phoenix', event:'heartbeat', ref:pendingHeartbeat, payload:{}});
        }, heartbeatInterval);
        onStatus(true);
      } else if (connected && event === 'broadcast' && payload?.event === 'changed') {
        onChange();
      }
    };
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    disconnect();
  };
}
