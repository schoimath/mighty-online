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

// Keep the editor and its confirmation attached to the item being changed.
// Removing that item on navigation or logout also invalidates any pending UI response.
export function authorActions({name, title, body, limit, removal, change, saved}) {
  const box = element('div',null,'author-actions');
  const edit = button('수정',editForm), remove = button('삭제',confirmRemoval);
  edit.setAttribute('aria-label',name+' 수정');
  remove.setAttribute('aria-label',name+' 삭제');
  function restore(focus) {
    box.replaceChildren(edit,remove);
    focus?.focus();
  }
  function submitForm(form, payload, submit) {
    const status = element('p',null,'form-error');
    status.setAttribute('role','alert');
    form.append(status);
    form.onsubmit = async event => {
      event.preventDefault();
      if (!form.isConnected || submit.disabled) return;
      const data = payload();
      for (const control of form.elements) control.disabled = true;
      status.textContent='';
      try {
        await change(data);
        if (form.isConnected) saved(data.p_delete);
      } catch (error) {
        if (!form.isConnected) return;
        status.textContent=boardError(error);
        for (const control of form.elements) control.disabled = false;
      }
    };
  }
  function editForm() {
    const form=element('form'), subject=element('input'), text=element('textarea');
    if (title !== undefined) {
      const label=element('label','제목','field');
      subject.value=title; subject.required=true; subject.maxLength=100; label.append(subject); form.append(label);
    }
    const label=element('label',name+' 내용','field');
    text.value=body; text.rows=4; text.required=true; text.maxLength=limit; label.append(text);
    const submit=element('button','수정 저장','primary-button');
    submit.type='submit';
    form.append(label,submit,button('취소',() => restore(edit)));
    submitForm(form,() => ({p_delete:false,p_title:subject.value.trim(),p_body:text.value.trim()}),submit);
    box.replaceChildren(form);
    (title === undefined ? text : subject).focus();
  }
  function confirmRemoval() {
    const form=element('form'), cancel=button('취소',() => restore(remove)), submit=element('button','삭제하기','plain-button author-delete');
    submit.type='submit';
    form.append(element('p',removal),cancel,submit);
    submitForm(form,() => ({p_delete:true,p_title:null,p_body:null}),submit);
    box.replaceChildren(form);
    cancel.focus();
  }
  restore();
  return box;
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
