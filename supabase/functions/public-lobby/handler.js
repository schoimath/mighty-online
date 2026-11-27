import {operateLobby} from './lobby.js';
import {lobbyChips} from './chips.js';

const headers = {'content-type':'application/json; charset=utf-8','cache-control':'no-store',
  'access-control-allow-origin':'*','access-control-allow-methods':'POST, OPTIONS',
  'access-control-allow-headers':'authorization, apikey, content-type, x-client-info'};
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers});
const fail = (message,status,code) => Object.assign(new Error(message),{status,code});

function repository(url,publicKey,serviceKey,bearer,send) {
  async function rpc(name,args,personal=false) {
    const key = personal ? publicKey : serviceKey;
    const authorization = personal ? bearer : serviceKey.startsWith('sb_secret_') ? null : 'Bearer '+serviceKey;
    const response = await send(url+'/rest/v1/rpc/'+name,{method:'POST',
      headers:{apikey:key,'content-type':'application/json',...(authorization ? {Authorization:authorization} : {})},
      body:JSON.stringify(args)});
    const value = await response.json();
    if (!response.ok) {
      if (value?.code === 'P0001') throw fail(value.message,409,value.details || undefined);
      throw fail('테이블 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',503);
    }
    return value;
  }
  return {read:slot => rpc('mighty_lobby_read',{p_slot:slot}),commit:args => rpc('mighty_lobby_commit',args),
    chips:lobbyChips(url,publicKey,serviceKey,send),
    async canPlay() {
      const wallet = await rpc('chip_wallet',{},true);
      if (!(wallet?.balance > 0)) throw fail('칩이 있는 계정으로 참가할 수 있습니다. 관전은 계속할 수 있습니다.',403);
    }};
}

export function lobbyHandler({url,publicKey,serviceKey,send=fetch}) {
  return async request => {
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers});
    if (request.method !== 'POST') return json({error:'POST 요청을 사용해 주세요.'},405);
    if (!url || !publicKey || !serviceKey) return json({error:'공개 테이블 서버 설정을 확인해 주세요.'},503);
    let input;
    try {
      if (Number(request.headers.get('content-length')) > 8192) return json({error:'요청이 너무 큽니다.'},413);
      const body = await request.text();
      if (body.length > 8192) return json({error:'요청이 너무 큽니다.'},413);
      input = JSON.parse(body);
    } catch { return json({error:'요청 내용을 확인해 주세요.'},400); }
    try {
      const bearer = request.headers.get('authorization');
      let accountId = null;
      if (bearer) {
        if (!/^Bearer [^\s]+$/i.test(bearer)) throw fail('로그인을 다시 해 주세요.',401);
        const response = await send(url+'/auth/v1/user',{headers:{apikey:publicKey,Authorization:bearer}});
        if (!response.ok) throw fail('로그인 정보를 확인할 수 없습니다.',response.status >= 500 ? 503 : 401);
        const user = await response.json();
        if (!user.email_confirmed_at || !user.id) throw fail('이메일 인증을 완료해 주세요.',403);
        accountId = user.id.toLowerCase();
      }
      return json(await operateLobby(input,accountId,repository(url,publicKey,serviceKey,bearer,send)));
    } catch (error) {
      if (error.status) return json({error:error.message,...(error.code ? {code:error.code} : {})},error.status);
      if (/^[가-힣]/u.test(error.message)) return json({error:error.message},400);
      return json({error:'공개 테이블에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'},503);
    }
  };
}
