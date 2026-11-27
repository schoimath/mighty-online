const titles = {signin:'로그인', signup:'회원가입', sent:'인증 메일 확인', forgot:'비밀번호 재설정',
  resend:'인증 메일 다시 받기', password:'새 비밀번호 설정', checking:'메일 링크 확인 중',
  linkError:'메일 링크 확인', account:'내 계정'};
const format = new Intl.NumberFormat('ko-KR');
const field = (name, label, type, attrs = '') =>
  `<label class="field">${label}<input name="${name}" type="${type}" required ${attrs}></label>`;
const emailField = field('email','이메일','email','autocomplete="email" maxlength="254"');
const passField = (label, fresh) => field('password',label,'password',fresh ? 'autocomplete="new-password" minlength="8"' : 'autocomplete="current-password"');
const link = (action, label) => `<button class="account-link" type="button" data-account="${action}">${label}</button>`;
const actions = (...links) => '<div class="account-actions">' + links.join('') + '</div>';
const form = (fields, submit) => '<form id="account-form">' + fields +
  '<button class="primary-button form-submit" type="submit">' + submit + '</button></form>';

export function setupAccountUI(client, {onChange} = {}) {
  const $ = id => document.getElementById(id);
  const dialog = $('account-dialog'), body = $('account-body');
  let page = 'signin', email = '', busy = false, handledLink = false, gameChip = null;
  let revision = 0;

  function note(value = '') {
    $('account-status').textContent = value;
    $('account-status').hidden = !value;
  }
  function balanceText(state) {
    return state.balance === null ? '잔액 확인 중' : format.format(state.balance) + '칩';
  }
  function paintHeader(state) {
    const chip = $('account-chips');
    $('profile-name').textContent = state.user?.nickname || '로그인';
    $('profile-btn').setAttribute('aria-label', state.user ? state.user.nickname + ' · 내 계정' : '이메일 로그인 또는 회원가입');
    for (const el of [chip, gameChip]) {
      if (!el) continue;
      el.hidden = !state.user;
      const text = state.error && state.balance === null ? '잔액 조회 필요' : balanceText(state);
      if (el.textContent !== text) el.textContent = text;
      el.title = '내 게임 칩 잔액';
    }
  }
  function render() {
    const state = client.state;
    $('account-title').textContent = titles[page];
    $('account-error').textContent = '';
    if (!state.configured) {
      body.innerHTML = '<p>계정 서버 연결을 준비하고 있습니다. 로비에서 무료 연습을 이용할 수 있습니다.</p>';
      return;
    }
    if (page === 'account' && state.user) {
      body.innerHTML = '<dl class="account-summary"><div><dt>닉네임</dt><dd data-value="nickname"></dd></div>' +
        '<div><dt>인증 이메일</dt><dd data-value="email"></dd></div><div><dt>보유 칩</dt><dd data-value="balance"></dd></div>' +
        '<div><dt>전체 칩 순위</dt><dd data-value="rank"></dd></div></dl>' +
        '<p data-recovery hidden></p>' + actions(link('refresh','잔액·순위 다시 조회'),link('logout','로그아웃'));
      body.querySelector('[data-value="nickname"]').textContent = state.user.nickname;
      body.querySelector('[data-value="email"]').textContent = state.user.email;
      updateWalletDetails();
      return;
    }
    if (page === 'checking') {
      body.replaceChildren();
    } else if (page === 'linkError') {
      body.innerHTML = actions(link('forgot','재설정 메일 다시 받기'),link('sent','가입 인증 코드 입력'),link('signin','로그인'));
      $('account-error').textContent = state.linkError;
    } else if (page === 'signup') {
      body.innerHTML = form(field('nickname','테이블 닉네임','text','autocomplete="nickname" maxlength="16"') +
        emailField + passField('비밀번호 (8자 이상)',true), '인증 메일 받기') +
        '<p>이메일 인증을 마치면 처음 한 번 1,000칩을 받습니다.</p>' + actions(link('signin','로그인'));
    } else if (page === 'sent') {
      body.innerHTML = '<p>메일에 적힌 숫자 코드를 입력하거나 메일의 인증 링크를 열어 주세요.</p>' +
        form(emailField + field('code','이메일 인증 코드','text','autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6,10}" maxlength="10"'), '인증 확인') +
        actions(link('signin','로그인'),link('resend','인증 메일 다시 받기'));
    } else if (page === 'forgot' || page === 'resend') {
      const resendHelp = '<p>처음 회원가입에서 메일 발송 오류가 떴다면 회원가입부터 다시 진행해 주세요.</p>';
      body.innerHTML = form(emailField, page === 'forgot' ? '재설정 메일 받기' : '인증 메일 보내기') +
        (page === 'resend' ? resendHelp + actions(link('signup','회원가입'),link('signin','로그인')) : actions(link('signin','로그인')));
    } else if (page === 'password') {
      body.innerHTML = form(passField('새 비밀번호 (8자 이상)',true),'새 비밀번호 저장') +
        actions(link('forgot','재설정 메일 다시 받기'));
    } else {
      body.innerHTML = form(emailField + passField('비밀번호',false),'로그인') +
        actions(link('signup','회원가입'),link('sent','인증 코드 입력'),link('forgot','비밀번호 재설정'),link('resend','인증 메일 다시 받기'));
    }
    const address = body.querySelector('[name=email]');
    if (address) address.value = email;
  }
  function updateWalletDetails() {
    const state = client.state, value = body.querySelector('[data-value=balance]');
    if (!value) return;
    const pending = state.error ? '조회 필요' : '확인 중…';
    value.textContent = state.balance === null ? pending : format.format(state.balance) + '칩';
    const rank = body.querySelector('[data-value=rank]');
    if (state.chipRank) rank.textContent = (state.chipRank.tied ? '공동 ' : '') + format.format(state.chipRank.rank) + '위';
    else rank.textContent = state.balance === null ? pending : '조회 불가';
    const recovery = body.querySelector('[data-recovery]');
    recovery.hidden = !state.recoveryDate;
    recovery.textContent = state.recoveryDate ? '한국시간 ' + state.recoveryDate + ' 0시부터 100칩으로 복구됩니다.' : '';
    $('account-error').textContent = state.error;
  }
  function show(next, message = '', focus = true) {
    page = next;
    note(message);
    render();
    const first = page === 'sent' && email ? body.querySelector('[name=code]') : body.querySelector('input, button');
    if (focus) first?.focus({preventScroll:true});
  }
  function open(message = '') {
    if (!dialog.open) dialog.showModal();
    const state = client.state;
    show(state.recovering ? 'password' : state.user ? 'account' : 'signin',message);
    if (page === 'account') void client.refreshWallet();
  }
  $('account-close').onclick = () => dialog.close();
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { revision++; busy = false; body.replaceChildren(); note(); });

  async function run(operation) {
    if (busy) return;
    busy = true;
    const active = ++revision;
    for (const el of body.querySelectorAll('button,input')) el.disabled = true;
    $('account-error').textContent = '';
    try {
      const next = await operation();
      if (dialog.open && active === revision && next) show(...next);
    } catch (error) {
      if (dialog.open && active === revision) {
        note();
        if (page === 'password' && client.state.linkError) show('linkError');
        else $('account-error').textContent = error.message;
      }
    } finally {
      if (active === revision) {
        busy = false;
        for (const el of body.querySelectorAll('button,input')) el.disabled = false;
      }
    }
  }
  body.addEventListener('click', e => {
    const action = e.target.closest('[data-account]')?.dataset.account;
    if (!action || busy) return;
    if (action === 'logout') return void run(async () => { await client.signOut(); return ['signin','로그아웃했습니다.']; });
    if (action === 'refresh') return void run(async () => { await client.refreshWallet(); return [client.state.user ? 'account' : 'signin']; });
    email = body.querySelector('[name=email]')?.value.trim() || email;
    show(action);
  });
  body.addEventListener('submit', e => {
    e.preventDefault();
    const values = new FormData(e.target);
    email = String(values.get('email') ?? email).trim();
    const password = values.get('password');
    run(async () => {
      switch (page) {
        case 'signup':
          await client.signUp(email,password,values.get('nickname'));
          return client.state.user ? ['account'] : ['sent','인증 메일을 요청했습니다.'];
        case 'signin':
          await client.signIn(email,password);
          return ['account'];
        case 'sent':
          await client.verifySignupCode(email,values.get('code'));
          return ['account','이메일 인증을 확인했습니다.'];
        case 'forgot':
          await client.resetPassword(email);
          return ['signin','가입한 주소라면 재설정 메일을 받습니다. 가장 최근 메일의 링크를 열어 주세요.'];
        case 'resend':
          await client.resend(email);
          return ['sent','인증 메일을 다시 요청했습니다.'];
        case 'password':
          note('새 비밀번호를 저장하고 있습니다…');
          await client.updatePassword(password);
          return ['account','새 비밀번호를 저장했습니다.'];
      }
    });
  });
  let previousId;
  client.subscribe(state => {
    onChange?.(state);
    paintHeader(state);
    if (state.authLink && !handledLink) {
      if (!dialog.open) dialog.showModal();
      if (state.linkError) {
        handledLink = true;
        show('linkError');
      } else if (state.recovering) {
        handledLink = true;
        show('password','새 비밀번호를 입력해 주세요.');
      } else if (state.ready) {
        handledLink = true;
        open(state.user ? '이메일 인증을 확인했습니다.' : '');
      } else if (page !== 'checking') {
        show('checking','메일 링크를 확인하고 있습니다…',false);
      }
    } else if (dialog.open && page === 'account' && previousId && previousId !== state.user?.id) {
      show(state.user ? 'account' : 'signin');
    } else if (dialog.open && !busy) {
      if (page === 'password' && state.linkError) show('linkError');
      else if (page === 'password' && !state.recovering) show('forgot','재설정할 계정이 바뀌었습니다. 메일을 다시 요청해 주세요.');
      else if (state.user && ['signin','sent','signup','resend'].includes(page)) show(state.recovering ? 'password' : 'account');
      else if (page === 'account') updateWalletDetails();
    }
    previousId = state.user?.id;
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && client.state.user) client.refreshWallet();
  });
  return {open, attach(container) {
    if (!container) return;
    gameChip = container.querySelector('[data-account-balance]');
    if (!gameChip) {
      gameChip = document.createElement('span');
      gameChip.className = 'account-chip';
      gameChip.dataset.accountBalance = '';
      container.prepend(gameChip);
    }
    paintHeader(client.state);
  }};
}
