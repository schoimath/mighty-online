const when = new Intl.DateTimeFormat('ko-KR', {dateStyle:'short',timeStyle:'short'});

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function button(label, click, className = 'plain-button') {
  const node = element('button', label, className);
  node.type = 'button';
  node.onclick = click;
  return node;
}

export function meta(label, date) {
  const node = element('div', null, 'support-meta');
  const time = element('time', when.format(new Date(date)));
  time.dateTime = date;
  node.append(element('span',label),time);
  return node;
}

export function pagination(data, go) {
  const pages = Math.ceil(data.total/data.pageSize);
  const nav = element('div',null,'support-pages');
  if (pages <= 1) { nav.hidden = true; return nav; }
  const prev = button('이전',() => go(data.page-1)), next = button('다음',() => go(data.page+1));
  prev.disabled = data.page <= 1; next.disabled = data.page >= pages;
  nav.append(prev,element('span',data.page+' / '+pages),next);
  return nav;
}

export async function boardRPC(client, name, args, readPublicly = false) {
  const actor = client.state.user?.id;
  await client.ready;
  const headers = {'Content-Type':'application/json',apikey:client.publishableKey};
  if (!readPublicly) {
    const token = await client.accessToken();
    if (!actor || !token || actor !== client.state.user?.id) throw new Error('로그인 후 이용해 주세요.');
    headers.Authorization = 'Bearer '+token;
  }
  const reply = await fetch(client.url + '/rest/v1/rpc/' + name,{
    method:'POST',cache:'no-store',headers,body:JSON.stringify(args),signal:AbortSignal.timeout(20000)
  });
  const value = await reply.json();
  if (!reply.ok) {
    if (reply.status === 401 || reply.status === 403) throw new Error('로그인 상태를 확인해 주세요.');
    if (value.code === '22023' || value.code === 'P0001') throw new Error(value.message);
    throw new Error('게시판에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  return value;
}

export function boardError(err) {
  return err instanceof TypeError || err.name === 'TimeoutError' || err.name === 'SyntaxError'
    ? '응답을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' : err.message;
}
