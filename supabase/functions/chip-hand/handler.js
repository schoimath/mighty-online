import {operateHand} from './hand.js';
import {settlements} from '../../../table-scoring.js';

const headers = {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store',
  'access-control-allow-origin':'*', 'access-control-allow-methods':'POST, OPTIONS',
  'access-control-allow-headers':'authorization, apikey, content-type, x-client-info'};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers});
const fail = (message, status, code) => Object.assign(new Error(message), {status, code});

function repository(url, publicKey, serviceKey, bearer, send) {
  async function rpc(name, args, privateCall) {
    const apiKey = privateCall ? serviceKey : publicKey;
    const auth = privateCall ? (serviceKey.startsWith('sb_secret_') ? null : 'Bearer ' + serviceKey) : bearer;
    const response = await send(url + '/rest/v1/rpc/' + name, {method:'POST',
      headers:{apikey:apiKey, 'Content-Type':'application/json', ...(auth ? {Authorization:auth} : {})},
      body:JSON.stringify(args)});
    const value = await response.json();
    if (!response.ok) {
      // Only controlled database business exceptions are safe for a browser.
      if (value?.code === 'P0001') throw fail(value.message, 409, value.details || undefined);
      if (value?.code === '42501') throw fail('방장 권한을 확인해 주세요.', 403);
      throw fail('게임 서버가 정보를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', 503);
    }
    return value;
  }
  return {
    active:() => rpc('chips_active_hand', {}, false),
    ready:(hand, room, seat, manifest) => rpc('chips_ready',
      {p_hand:hand, p_room:room, p_seat:seat, p_manifest:manifest}, false),
    start:(hand, spec, state) => rpc('chips_start_hand',
      {p_hand:hand, p_room:spec.room, p_host:spec.host, p_seats:spec.seats, p_state:state}, true),
    read:hand => rpc('chips_read_hand', {p_hand:hand}, true),
    control:(hand, proof, row) => rpc('mighty_chip_room_control', {p_hand:hand, p_actor:proof.id,
      p_term:proof.term, p_credential:proof.credential, p_legacy:proof.legacy,
      p_revision:row?.revision ?? null, p_state:row?.state ?? null}, true),
    save:row => {
      const round = row.state.round;
      const deltas = round.result ? settlements(round.result, round.bid.suit) : null;
      return rpc('chips_update_hand', {p_hand:row.hand, p_revision:row.revision,
        p_state:row.state, p_deltas:deltas}, true);
    }
  };
}

// Auth's verified identity is the only path to a private seat. The service key
// only travels to this deployment's own PostgREST endpoint.
export function chipHandler({url, publicKey, serviceKey, send = fetch}) {
  return async request => {
    if (request.method === 'OPTIONS') return new Response(null, {status:204, headers});
    if (request.method !== 'POST') return json({error:'POST 요청을 사용해 주세요.'}, 405);
    if (!url || !publicKey || !serviceKey) return json({error:'게임 서버 설정을 확인해 주세요.'}, 503);
    let payload;
    try {
      if (Number(request.headers.get('content-length')) > 8192) return json({error:'요청이 너무 큽니다.'}, 413);
      const body = await request.text();
      if (body.length > 8192) return json({error:'요청이 너무 큽니다.'}, 413);
      payload = JSON.parse(body);
    } catch { return json({error:'요청 내용을 확인해 주세요.'}, 400); }

    try {
      const bearer = request.headers.get('authorization');
      let id = null;
      const roomControl = ['room-takeover','room-pace','room-auto-play'].includes(payload?.op);
      if (!['watch','tick'].includes(payload?.op) && (!roomControl || bearer)) {
        if (!bearer || !/^Bearer [^\s]+$/i.test(bearer)) throw fail('로그인이 필요합니다.', 401);
        const result = await send(url + '/auth/v1/user', {headers:{apikey:publicKey, Authorization:bearer}});
        if (!result.ok) throw fail(result.status >= 500 ? '로그인 서버 연결을 확인해 주세요.' : '로그인을 다시 해 주세요.', result.status >= 500 ? 503 : 401);
        const user = await result.json();
        if (!user.email || !user.email_confirmed_at) throw fail('이메일 인증을 완료해 주세요.', 403);
        id = user.id;
      }
      const db = repository(url, publicKey, serviceKey, bearer, send);
      return json(await operateHand(payload, id, db));
    } catch (error) {
      if (error.status) return json({error:error.message, ...(error.code ? {code:error.code} : {})}, error.status);
      // Validation errors from the shared Korean-language game rules.
      if (/^[가-힣]/u.test(error.message)) return json({error:error.message}, 400);
      return json({error:'게임 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'}, 503);
    }
  };
}
