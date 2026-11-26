import {accountConfig} from './account-config.js';

const WALLET_TIMEOUT_MS = 8000;

const errorMessages = {
  invalid_credentials:'이메일 또는 비밀번호를 확인해 주세요.',
  email_not_confirmed:'이메일 인증을 마친 뒤 로그인해 주세요.',
  email_address_invalid:'이메일 주소를 확인해 주세요.',
  email_address_not_authorized:'인증 메일을 발송할 수 없습니다. 운영자에게 문의해 주세요.',
  user_already_exists:'이미 가입한 이메일입니다. 로그인해 주세요.',
  weak_password:'더 긴 비밀번호를 사용해 주세요.',
  same_password:'기존 비밀번호와 다른 비밀번호를 입력해 주세요.',
  signup_disabled:'지금은 새 계정을 만들 수 없습니다.',
  otp_expired:'메일 링크의 유효기간이 지났거나 이미 사용했습니다. 메일을 다시 요청해 주세요.',
  bad_code_verifier:'메일을 요청한 브라우저에서 링크를 열어 주세요. 비밀번호 재설정은 새 메일을 요청할 수 있습니다.',
  flow_state_not_found:'메일 링크가 만료되었습니다. 메일을 새로 요청해 주세요.',
  over_email_send_rate_limit:'메일 요청이 많습니다. 잠시 후 다시 시도해 주세요.',
  over_request_rate_limit:'요청이 많습니다. 잠시 후 다시 시도해 주세요.'
};

const mailFailureMessages = {
  signup:'서버에서 가입 인증 메일을 보내지 못했습니다. 메일 발송이 복구되면 이 화면에서 회원가입을 다시 시도해 주세요.',
  resend:'서버에서 인증 메일을 다시 보내지 못했습니다. 메일 발송이 복구되면 다시 요청해 주세요.',
  recovery:'서버에서 비밀번호 재설정 메일을 보내지 못했습니다. 메일 발송이 복구되면 다시 요청해 주세요.'
};

function unwrap({data, error}, mailAction) {
  if (!error) return data;
  if (mailAction && error.status === 500 && /^Error sending (?:confirmation|recovery) email(?:$|:)/i.test(error.message)) {
    throw new Error(mailFailureMessages[mailAction]);
  }
  throw new Error(errorMessages[error.code] || '계정 요청을 마치지 못했습니다. 연결 상태와 입력한 내용을 확인해 주세요.');
}

// Remove one-time credentials before any room invitation can reuse this URL.
// Password signup/recovery use PKCE. A custom Supabase email template may
// instead link to the site with token_hash and type to verify across devices.
export function takeAccountLink(location, history) {
  if (!location || !history) return null;
  const url = new URL(location.href);
  const params = url.searchParams;
  const hash = new URLSearchParams(url.hash.slice(1));
  const legacyTokens = hash.has('access_token') || hash.has('refresh_token');
  const error = params.get('error_code') || hash.get('error_code') || params.get('error') || hash.get('error');
  const tokenParams = hash.has('token_hash') || hash.get('type') === 'recovery' ? hash : params;
  const link = {error, code:params.get('code'), flowId:params.get('sb_flow_id'), hash:tokenParams.get('token_hash'), type:tokenParams.get('type')};
  if (!link.code && !link.hash && !error && !legacyTokens && link.type !== 'recovery') return null;
  for (const key of ['code','sb_flow_id','token_hash','type','error','error_code','error_description']) params.delete(key);
  if (tokenParams === hash || hash.has('error') || hash.has('error_code') || legacyTokens) url.hash = '';
  if (legacyTokens) link.error = 'unsupported_callback';
  history.replaceState(history.state, '', url.href);
  return link;
}

async function loadAuth(url, publishableKey) {
  const {default:AuthClient} = await import('./vendor/supabase-auth-2.119.2/auth.js');
  return new AuthClient({
    url:url + '/auth/v1', headers:{apikey:publishableKey},
    storageKey:'mighty-auth-' + new URL(url).host, flowType:'pkce',
    detectSessionInUrl:false, persistSession:true, autoRefreshToken:true
  });
}

export class AccountClient {
  #auth;
  #listeners = new Set();
  #pendingWallet = null;
  #identityVersion = 0;
  #recoveryTimer;
  #pendingRecoveryHash = null;
  #recoveryUserId = null;
  #fetch;
  #redirect;
  #state;

  constructor(config, {makeAuth = loadAuth, fetcher = globalThis.fetch, location = globalThis.location,
    history = globalThis.history} = {}) {
    this.url = String(config?.url ?? '').replace(/\/+$/, '');
    this.publishableKey = String(config?.publishableKey ?? '');
    this.#fetch = fetcher.bind(globalThis);
    this.#redirect = location ? new URL('.', location.href).href : undefined;
    this.#state = {configured:Boolean(this.url && this.publishableKey), ready:false,
      user:null, balance:null, recoveryDate:null, recovering:false, authLink:false, linkError:'', error:''};
    const link = takeAccountLink(location,history);
    this.identityReady = this.#restoreIdentity(makeAuth,link);
    this.ready = this.identityReady.then(async () => {
      if (this.state.user && !link) await this.refreshWallet();
      this.#set({ready:true});
      if (link && this.state.user) void this.refreshWallet();
    });
  }

  get state() { return this.#state; }
  subscribe(callback) {
    this.#listeners.add(callback);
    callback(this.state);
    return () => this.#listeners.delete(callback);
  }
  #set(fields) {
    this.#state = {...this.#state, ...fields};
    for (const callback of this.#listeners) callback(this.state);
  }
  async #restoreIdentity(makeAuth, link) {
    try {
      if (link) {
        if (link.type === 'recovery' && !link.error) this.#pendingRecoveryHash = link.hash;
        this.#set({authLink:true,recovering:Boolean(this.#pendingRecoveryHash)});
      }
      if (!this.state.configured) return;
      this.#auth = await makeAuth(this.url, this.publishableKey);
      const early = unwrap(await this.#auth.getSession());
      this.#session(early.session);
      this.#auth.onAuthStateChange((event, session) => {
        if (event === 'INITIAL_SESSION') return;
        const changed = this.#session(session);
        // Auth callbacks run inside the SDK. Start new authenticated requests
        // after it releases its session lock.
        if (changed && this.state.user) setTimeout(() => this.refreshWallet(), 0);
      });
      if (link?.error) throw new Error(errorMessages[link.error] || '인증 링크를 확인할 수 없습니다. 메일을 다시 요청해 주세요.');
      if (this.#pendingRecoveryHash) {
        // Verify only when the recipient submits a password. A mail preview can open this page.
        return;
      } else if (link?.hash && ['email','signup'].includes(link.type)) {
        const data = unwrap(await this.#auth.verifyOtp({token_hash:link.hash, type:link.type}));
        this.#session(data.session);
      } else if (link?.code) {
        const {data,error} = await this.#auth.exchangeCodeForSession(link.code,link.flowId ? {flowId:link.flowId} : undefined);
        if (error) throw new Error(errorMessages[error.code] || '메일을 요청한 브라우저에서 링크를 열어 주세요. 다른 브라우저라면 새 메일을 요청해 주세요.');
        if (data.redirectType === 'recovery') this.#acceptRecovery(data.session);
        else this.#session(data.session);
      } else if (link) {
        throw new Error('메일 링크를 확인할 수 없습니다. 메일을 다시 요청해 주세요.');
      }
    } catch (error) {
      this.#set(link ? {linkError:error.message, recovering:false} : {error:error.message});
    }
  }
  #session(session) {
    const raw = session?.user;
    const user = raw?.email_confirmed_at && raw.email ? {
      id:raw.id, email:raw.email, nickname:String(raw.user_metadata?.nickname ?? '').trim().slice(0,16) || '플레이어'
    } : null;
    const changed = this.state.user?.id !== user?.id;
    if (changed) {
      this.#identityVersion++;
      this.#recoveryUserId = null;
      clearTimeout(this.#recoveryTimer);
      this.#pendingWallet = null;
      this.#set({user, balance:null, recoveryDate:null, recovering:Boolean(this.#pendingRecoveryHash), error:''});
    } else if (user && (this.state.user.email !== user.email || this.state.user.nickname !== user.nickname)) {
      this.#set({user});
    }
    return changed;
  }
  async #service() {
    await this.identityReady;
    if (!this.#auth) throw new Error('계정 서버 연결을 준비하고 있습니다. 무료 연습을 이용해 주세요.');
    return this.#auth;
  }
  async accessToken() {
    await this.identityReady;
    const auth = this.#auth;
    if (!auth) return null;
    const {session} = unwrap(await auth.getSession());
    return session?.user?.email_confirmed_at ? session.access_token : null;
  }
  async refreshWallet() {
    if (!this.#auth || !this.state.user) return this.state;
    if (this.#pendingWallet) return this.#pendingWallet;
    const userId = this.state.user.id;
    const pending = this.#readWallet(userId,this.#identityVersion);
    this.#pendingWallet = pending;
    try { return await pending; }
    finally { if (this.#pendingWallet === pending) this.#pendingWallet = null; }
  }
  async #fetchWallet(userId,signal) {
    const {session} = unwrap(await this.#auth.getSession());
    if (signal.aborted || session?.user.id !== userId || !session.user.email_confirmed_at) return;
    const response = await this.#fetch(this.url + '/rest/v1/rpc/chip_wallet', {
      method:'POST', cache:'no-store', signal, headers:{apikey:this.publishableKey,
        Authorization:'Bearer ' + session.access_token, 'Content-Type':'application/json'}, body:'{}'
    });
    if (!response.ok) throw new Error();
    return response.json();
  }
  async #readWallet(userId,identityVersion) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_,reject) => {
      timer = setTimeout(() => { controller.abort(); reject(controller.signal.reason); },WALLET_TIMEOUT_MS);
    });
    try {
      // The same deadline covers the SDK session lock, HTTP headers and body.
      const wallet = await Promise.race([this.#fetchWallet(userId,controller.signal),timeout]);
      if (wallet === undefined) return this.state;
      if (!Number.isSafeInteger(wallet.balance)) throw new Error();
      if (this.#identityVersion !== identityVersion) return this.state;
      this.#set({balance:wallet.balance, recoveryDate:wallet.recoveryDate ?? null, error:''});
      clearTimeout(this.#recoveryTimer);
      if (wallet.recoveryDate) {
        const wait = Date.parse(wallet.recoveryDate + 'T00:00:00+09:00') - Date.now();
        if (Number.isFinite(wait)) this.#recoveryTimer = setTimeout(() => this.refreshWallet(),
          Math.min(2147483647, Math.max(1000, wait + 250)));
        this.#recoveryTimer?.unref?.();
      }
    } catch {
      if (this.#identityVersion === identityVersion) this.#set({balance:null, error:'칩 잔액을 확인하지 못했습니다. 잠시 후 다시 조회해 주세요.'});
    } finally {
      clearTimeout(timer);
    }
    return this.state;
  }
  async signUp(email,password,nickname) {
    nickname = nickname.trim();
    if (!nickname || nickname.length > 16) throw new Error('닉네임은 1~16자로 입력해 주세요.');
    const auth = await this.#service();
    const data = unwrap(await auth.signUp({email:email.trim(),password,options:{data:{nickname},emailRedirectTo:this.#redirect}}), 'signup');
    if (data.session) this.#session(data.session);
  }
  async signIn(email,password) {
    const auth = await this.#service();
    this.#session(unwrap(await auth.signInWithPassword({email:email.trim(),password})).session);
    if (!this.state.user) throw new Error(errorMessages.email_not_confirmed);
    return this.refreshWallet();
  }
  async resend(email) {
    const auth = await this.#service();
    unwrap(await auth.resend({type:'signup',email:email.trim(),options:{emailRedirectTo:this.#redirect}}), 'resend');
  }
  async verifySignupCode(email,code) {
    const address = email.trim().toLowerCase();
    const token = code.trim();
    if (!/^[0-9]{6,10}$/.test(token)) throw new Error('메일에 표시된 숫자 코드 6~10자리를 입력해 주세요.');
    const auth = await this.#service();
    const current = this.state.user;
    if (current) {
      if (current.email.toLowerCase() === address) return this.refreshWallet();
      throw new Error('다른 계정으로 로그인 중입니다. 로그아웃한 후 가입 인증을 진행해 주세요.');
    }
    const response = await auth.verifyOtp({type:'email',email:address,token});
    if (response.error?.code === 'otp_expired') {
      throw new Error('코드가 틀렸거나 만료되었습니다. 가장 최근 메일의 코드를 확인해 주세요. 인증을 이미 마쳤다면 비밀번호로 로그인하세요.');
    }
    const {session} = unwrap(response);
    if (!session?.user.email_confirmed_at || session.user.email?.toLowerCase() !== address) {
      throw new Error('인증한 계정의 로그인을 확인하지 못했습니다. 가입한 이메일과 비밀번호로 로그인해 주세요.');
    }
    this.#session(session);
    return this.refreshWallet();
  }
  async resetPassword(email) {
    const auth = await this.#service();
    unwrap(await auth.resetPasswordForEmail(email.trim(), {redirectTo:this.#redirect}), 'recovery');
  }
  #acceptRecovery(session) {
    if (!session?.user?.id || !session.user.email_confirmed_at || !session.user.email) {
      throw new Error('비밀번호를 재설정할 계정을 확인하지 못했습니다. 새 메일을 요청해 주세요.');
    }
    this.#session(session);
    this.#recoveryUserId = session.user.id;
    this.#set({recovering:true});
  }
  async updatePassword(password) {
    if (typeof password !== 'string' || password.length < 8) throw new Error('새 비밀번호를 8자 이상 입력해 주세요.');
    const auth = await this.#service();
    if (this.#pendingRecoveryHash) {
      const response = await auth.verifyOtp({type:'recovery',token_hash:this.#pendingRecoveryHash});
      if (response.error?.code === 'otp_expired') {
        this.#pendingRecoveryHash = null;
        this.#set({linkError:errorMessages.otp_expired,recovering:false});
      }
      const {session} = unwrap(response);
      this.#acceptRecovery(session);
      this.#pendingRecoveryHash = null;
    }
    const {session} = unwrap(await auth.getSession());
    if (!this.#recoveryUserId || !session?.access_token || session.user?.id !== this.#recoveryUserId || this.state.user?.id !== this.#recoveryUserId) {
      throw new Error('비밀번호 재설정 세션이 끝났습니다. 새 메일을 요청해 주세요.');
    }
    // The SDK's updateUser reads the shared session again. Pin this write to the
    // verified user's bearer token even if another tab signs into a different account.
    let response;
    try {
      response = await this.#fetch(this.url + '/auth/v1/user', {
        method:'PUT', cache:'no-store', headers:{apikey:this.publishableKey,
          Authorization:'Bearer ' + session.access_token, 'Content-Type':'application/json',
          'X-Supabase-Api-Version':'2024-01-01'}, body:JSON.stringify({password})
      });
    } catch {
      throw new Error('비밀번호 저장 결과를 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.');
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(errorMessages[error?.code || error?.error_code] || (response.status === 401 || response.status === 403
        ? '비밀번호 재설정 세션이 끝났습니다. 새 메일을 요청해 주세요.'
        : '새 비밀번호를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.'));
    }
    this.#recoveryUserId = null;
    this.#set({recovering:false, error:''});
    if (this.state.user && this.state.balance === null) void this.refreshWallet();
  }
  async signOut() {
    const auth = await this.#service();
    unwrap(await auth.signOut({scope:'local'}));
    this.#session(null);
  }
}

export const accountClient = new AccountClient(accountConfig);
