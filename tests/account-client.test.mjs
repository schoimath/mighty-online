import assert from 'node:assert/strict';
import test from 'node:test';
import {AccountClient,takeAccountLink} from '../account-client.js';

const config = {url:'https://mighty.example',publishableKey:'public-key'};
const person = (id = 'player', confirmed = true) => ({id,email:id+'@example.org',
  email_confirmed_at:confirmed ? '2026-11-26T00:00:00Z' : null,user_metadata:{nickname:'마이티친구'}});
const authSession = user => ({user,access_token:user.id+'-token'});
const ok = data => ({data,error:null});
const mockWallet = balance => ({ok:true,json:async () => ({balance,recoveryDate:null})});

function authStub(initialUser,callbackType) {
  let session = initialUser && authSession(initialUser), handler;
  const calls = [];
  return {
    calls,
    getSession:async () => ok({session}),
    onAuthStateChange(fn) { handler = fn; },
    async signUp(input) { calls.push(['signup',input]); return ok({session:null}); },
    async signInWithPassword(input) {
      calls.push(['signin',input]);
      session = authSession(person());
      handler('SIGNED_IN',session);
      return ok({session});
    },
    async exchangeCodeForSession(code) {
      calls.push(['exchange',code]);
      session = authSession(person());
      handler(callbackType === 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN',session);
      return ok({session,redirectType:callbackType});
    },
    async updateUser(input) { calls.push(['update',input]); return ok({user:session.user}); },
    async signOut(options) { calls.push(['signout',options]); session = null; handler('SIGNED_OUT',null); return ok({}); },
    async resetPasswordForEmail(...args) { calls.push(['reset',...args]); return ok({}); },
    async resend(input) { calls.push(['resend',input]); return ok({}); }
  };
}

test('signup uses the canonical site return URL and never assigns chips to pending email', async () => {
  const auth = authStub();
  const client = new AccountClient(config,{location:new URL('https://club.example/mighty/?room=ABC234#extra'),
    makeAuth:async () => auth, fetcher:() => assert.fail('pending accounts must not call a wallet')});
  await client.ready;
  await client.signUp(' a@example.org ','password123',' 친구 ');
  await client.resend(' a@example.org ');
  await client.resetPassword(' a@example.org ');
  assert.deepEqual(auth.calls,[
    ['signup',{email:'a@example.org',password:'password123',options:{data:{nickname:'친구'},emailRedirectTo:'https://club.example/mighty/'}}],
    ['resend',{type:'signup',email:'a@example.org',options:{emailRedirectTo:'https://club.example/mighty/'}}],
    ['reset','a@example.org',{redirectTo:'https://club.example/mighty/'}]
  ]);
  assert.equal(client.state.user,null);
  assert.equal(client.state.balance,null);
  assert.equal(await client.accessToken(),null);
});

test('verified login reads chips from the authenticated RPC, including zero and negative balances', async () => {
  const auth = authStub(), requests=[];
  let balance = 1000;
  const client = new AccountClient(config,{makeAuth:async () => auth,fetcher:async (url,opts) => {
    requests.push([url,opts]);return mockWallet(balance);
  }});
  await client.ready;
  await client.signIn('player@example.org','password123');
  assert.deepEqual(client.state.user,{id:'player',email:'player@example.org',nickname:'마이티친구'});
  assert.equal(client.state.balance,1000);
  for (balance of [0,-12,100]) assert.equal((await client.refreshWallet()).balance,balance);
  for (const [url,opts] of requests) {
    assert.equal(url,'https://mighty.example/rest/v1/rpc/chip_wallet');
    assert.equal(opts.headers.Authorization,'Bearer player-token');
    assert.equal(opts.body,'{}');
  }
  await client.signOut();
  assert.equal(client.state.balance,null);
  assert.equal(await client.accessToken(),null);
});

test('signup, resend and password recovery identify mail delivery failures and give the appropriate retry action', async () => {
  const auth = authStub();
  const failSending = message => async () => ({data:null,error:{status:500,code:'unexpected_failure',message}});
  auth.signUp = auth.resend = failSending('Error sending confirmation email');
  auth.resetPasswordForEmail = failSending('Error sending recovery email: private provider detail');
  const client = new AccountClient(config,{makeAuth:async () => auth});
  const email = 'member@example.org';
  await assert.rejects(client.signUp(email,'password123','회원'), /가입 인증 메일을 보내지 못했습니다.*회원가입을 다시/);
  await assert.rejects(client.resend(email), /인증 메일을 다시 보내지 못했습니다.*다시 요청/);
  await assert.rejects(client.resetPassword(email), error => {
    assert.match(error.message, /비밀번호 재설정 메일을 보내지 못했습니다.*다시 요청/);
    assert.doesNotMatch(error.message, /private provider detail/);
    return true;
  });
  assert.equal(client.state.user,null);
});

test('ordinary server and login errors retain their own messages', async () => {
  const auth = authStub();
  auth.signUp = async () => ({data:null,error:{status:500,code:'unexpected_failure',message:'Database error saving new user'}});
  auth.signInWithPassword = async () => ({data:null,error:{status:400,code:'invalid_credentials'}});
  auth.resend = async () => ({data:null,error:{status:429,code:'over_email_send_rate_limit'}});
  const client = new AccountClient(config,{makeAuth:async () => auth});
  const email = 'member@example.org';
  await assert.rejects(client.signUp(email,'password123','회원'), /계정 요청을 마치지 못했습니다/);
  await assert.rejects(client.signIn(email,'password123'), /이메일 또는 비밀번호를 확인/);
  await assert.rejects(client.resend(email), /메일 요청이 많습니다/);
});

test('wallet responses from a previous login are discarded after logout', async () => {
  const auth = authStub(person());
  let release, first = true;
  const client = new AccountClient(config,{makeAuth:async () => auth,fetcher:async () => {
    if (first) { first=false;return mockWallet(1000); }
    return new Promise(resolve => {release = resolve;});
  }});
  await client.ready;
  const read = client.refreshWallet();
  await new Promise(resolve=>setImmediate(resolve));
  await client.signOut();
  release(mockWallet(999));
  await read;
  assert.equal(client.state.balance,null);
  assert.equal(client.state.user,null);
});

test('verification codes are scrubbed before exchange and recovery opens the password flow', async () => {
  let clean = '';
  const auth = authStub(null,'recovery');
  const client = new AccountClient(config,{location:new URL('https://club.example/mighty/?code=ONEUSE&room=ABC234'),
    history:{state:null,replaceState:(_state,_title,url)=>{clean=url;}},
    makeAuth:async () => auth,fetcher:async () => mockWallet(30)});
  assert.equal(clean,'https://club.example/mighty/?room=ABC234');
  await client.ready;
  assert.equal(client.state.authLink,true);
  assert.equal(client.state.recovering,true);
  await client.updatePassword('new-password');
  assert.equal(client.state.recovering,false);
  assert.deepEqual(auth.calls, [['exchange','ONEUSE'], ['update',{password:'new-password'}]]);
});

test('usage is safe without configured account service and strips legacy fragment credentials', async () => {
  const client = new AccountClient({});
  await client.ready;
  assert.equal(client.state.configured,false);
  assert.equal(await client.accessToken(),null);
  await assert.rejects(client.signIn('friend@example.org','12345678'));
  let clean;
  const link=takeAccountLink(new URL('https://club.example/#access_token=PRIVATE&refresh_token=SECRET'),
    {state:null,replaceState:(_,__,url)=>{clean=url;}});
  assert.equal(clean,'https://club.example/');
  assert.equal(link.error,'unsupported_callback');
});
