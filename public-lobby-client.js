import {matchesOfferedSeries} from './table-series.js';

// Keep each visitor's membership separate from the host role. The credential
// lets a tab reconnect after a reload, including when its owner is anonymous.
export function lobbyCredential(slot, account) {
  const key = 'mighty-public-visitor-' + slot + '-' + (account || 'anonymous');
  try {
    const saved = sessionStorage.getItem(key);
    if (/^[a-f0-9]{64}$/.test(saved ?? '')) return saved;
  } catch {}
  const value = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2,'0')).join('');
  try { sessionStorage.setItem(key,value); } catch {}
  return value;
}

function relayAbort(signal, controller) {
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort',abort,{once:true});
  return () => signal?.removeEventListener('abort',abort);
}

export async function requestPublicLobby(client, payload, signal, account) {
  const token = await client.accessToken();
  if (account !== undefined && (account !== (client.state.user?.id ?? null) || Boolean(account) !== Boolean(token))) {
    throw Object.assign(new Error('로그인 상태가 변경되었습니다. 테이블에 다시 입장해 주세요.'), {status:401});
  }
  const headers = {'Content-Type':'application/json', apikey:client.publishableKey};
  if (token) headers.Authorization = 'Bearer ' + token;
  const controller = new AbortController();
  const unlink = relayAbort(signal,controller);
  const timeout = setTimeout(() => controller.abort(),18000);
  try {
    const response = await fetch(client.url.replace(/\/$/,'') + '/functions/v1/public-lobby', {
      method:'POST', headers, body:JSON.stringify(payload), cache:'no-store', redirect:'error',signal:controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw Object.assign(
      new Error(data.error || '테이블 서버에 연결하지 못했습니다. 다시 시도해 주세요.'),
      {code:data.code,status:response.status});
    return data;
  } catch (error) {
    if (signal?.aborted || error.status) throw error;
    throw new Error('테이블 서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
  } finally { clearTimeout(timeout); unlink(); }
}

export function mayConfirmPublicDeal(view, offer, room, account) {
  if (!view || !offer || !account || offer.room !== room || view.departing ||
      (view.game && view.game.phase !== 'result') || offer.seats?.length !== 5 ||
      (view.isHost && offer.host !== account)) return false;
  const seat = view.spectator ? view.reservation?.seat : view.seat;
  const seated = Number.isInteger(seat) && seat >= 0 && seat < 5;
  if (seated ? offer.seats[seat] !== account : !view.isHost || offer.seats.includes(account)) return false;
  return matchesOfferedSeries(offer.series, view.scoreboard) &&
    (offer.pace ?? 'normal') === view.pace && (offer.autoPlay === undefined || typeof offer.autoPlay === 'boolean') &&
    view.botModels.every((id,index) => offer.models?.[index] === id) &&
    Object.entries(view.rules).every(([key,value]) => offer.rules?.[key] === value);
}

export function openPublicLobby({slot,credential,initialRoomId,request,onState,onError,delay}) {
  const controller = new AbortController();
  let roomId = initialRoomId, cursor = initialRoomId ? undefined : 0;
  let timer, polling = false, active = true, warned = false, firstReply = true;
  let queue = Promise.resolve();
  // A mutation and a poll share one cursor. Process complete replies in order
  // so later polls cannot skip messages or undo an accepted seat change.
  function send(op, fields = {}, signal) {
    const task = queue.then(async () => {
      if (!active) throw new Error('테이블에서 나왔습니다.');
      const payload = {...fields,slot,credential,roomId,op,after:cursor};
      if (op !== 'poll') payload.requestId ??= crypto.randomUUID();
      const unlink = relayAbort(signal,controller);
      let data;
      try { data = await request(payload,controller.signal); }
      finally { unlink(); }
      if (!active) throw new Error('테이블에서 나왔습니다.');
      if (op === 'leave') return data;
      if (!data.roomId || (roomId && data.roomId !== roomId) || !data.view) {
        throw new Error('테이블 정보를 확인하지 못했습니다. 다시 입장해 주세요.');
      }
      roomId = data.roomId;
      if (Number.isSafeInteger(data.cursor)) cursor = Math.max(cursor ?? 0,data.cursor);
      warned = false;
      // A new visit starts at the live head. Its older messages come only
      // from the device's own chat log, including after a tab reload.
      onState(firstReply ? {...data,messages:[]} : data,op);
      firstReply = false;
      return data;
    });
    queue = task.catch(() => {});
    return task;
  }
  function schedule() {
    clearTimeout(timer);
    if (active && roomId) timer = setTimeout(wake,delay());
  }
  async function wake() {
    if (!active || !roomId || polling) return;
    clearTimeout(timer);
    polling = true;
    try { await send('poll'); }
    catch (error) {
      if (active && (!warned || error.status === 401 || error.status === 410)) onError(error);
      warned = true;
    } finally { polling = false; schedule(); }
  }
  return {send,wake,schedule,close() { active=false; clearTimeout(timer); controller.abort(); }};
}
