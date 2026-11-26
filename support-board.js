import {element,button,meta,pagination,boardRPC,boardError} from './board-ui.js';
const statusLabel = answered => answered ? '답변 완료' : '답변 대기';

export function setupSupportBoard(client, openAccount) {
  const dialog = document.getElementById('support-dialog');
  const body = document.getElementById('support-body');
  const errorLine = document.getElementById('support-error');
  let revision = 0, page = 1, user = client.state.user?.id;

  function clear() {
    revision++;
    body.replaceChildren();
    errorLine.textContent = '';
    dialog.scrollTop = 0;
  }

  const rpc = (name,args) => boardRPC(client,'mighty_support_'+name,args);

  function refresh() {
    clear();
    if (!user) {
      body.append(element('p','로그인하면 문의를 남기고 답변을 확인할 수 있습니다.'),button('로그인',openAccount,'primary-button'));
      return;
    }
    load('list',{p_page:page},list,refresh);
  }

  async function load(name, args, paint, retry) {
    clear();
    const current = revision;
    const progress = element('p','불러오는 중…');
    progress.setAttribute('role','status');
    body.append(progress);
    try {
      const result = await rpc(name,args);
      if (dialog.open && current === revision) { clear(); paint(result); }
    } catch (err) {
      if (!dialog.open || current !== revision) return;
      body.replaceChildren(button('다시 조회',retry));
      if (name !== 'list') body.append(button('목록으로',refresh));
      errorLine.textContent = boardError(err);
    }
  }

  function list(result) {
    const actions = element('div', null, 'support-actions');
    actions.append(button('문의 작성',() => compose(),'primary-button'),button('새로고침',refresh));
    body.append(actions);
    if (!result.items.length) {
      body.append(element('p','등록한 문의가 없습니다.'));
      return;
    }
    const rows = element('ul',null,'support-rows');
    for (const item of result.items) {
      const row = element('li'), open = button('',() => openThread(item.id),'');
      open.append(element('strong',item.title),meta(statusLabel(item.answered),item.updatedAt));
      row.append(open); rows.append(row);
    }
    body.append(rows);
    body.append(pagination(result,nextPage => {page=nextPage; refresh();}));
  }

  function openThread(id) { load('thread',{p_thread:id},thread,() => openThread(id)); }
  function thread(data) {
    const actions = element('div',null,'support-actions');
    actions.append(button('목록으로',refresh),button('새로고침',() => openThread(data.id)));
    body.append(actions,element('h3',data.title));
    const messages = element('ol',null,'support-messages');
    for (const message of data.messages) {
      const row = element('li',null,message.isAdmin ? 'admin' : '');
      row.append(meta(message.isAdmin ? '관리자' : '나',message.createdAt),element('p',message.body));
      messages.append(row);
    }
    body.append(messages,button('추가 문의',() => compose(data)));
  }

  function compose(previous) {
    clear();
    body.append(element('h3',previous ? previous.title : '새 문의'));
    const current = revision, id = crypto.randomUUID();
    const form = element('form');
    let title;
    if (!previous) {
      const label = element('label','제목','field');
      title = element('input'); title.required = true; title.maxLength = 100;
      label.append(title); form.append(label);
    }
    const label = element('label',previous ? '추가 문의 내용' : '내용','field');
    const message = element('textarea'); message.required = true; message.rows = 6; message.maxLength = 4000;
    label.append(message);
    const actions = element('div',null,'support-actions');
    const submit = element('button','등록','primary-button'); submit.type = 'submit';
    const cancel = button('취소',() => previous ? openThread(previous.id) : refresh());
    actions.append(submit,cancel); form.append(label,actions); body.append(form);
    (title ?? message).focus();
    form.onsubmit = async event => {
      event.preventDefault();
      if (submit.disabled || current !== revision || !dialog.open) return;
      const content = message.value.trim(), subject = title?.value.trim();
      if (!content || (title && !subject)) { errorLine.textContent='제목과 내용을 확인해 주세요.'; return; }
      for (const field of form.elements) field.disabled = true;
      errorLine.textContent = '';
      try {
        const result = previous ? await rpc('reply',{p_thread:previous.id,p_message:id,p_body:content})
          : await rpc('create',{p_thread:id,p_title:subject,p_body:content});
        if (!dialog.open || current !== revision) return;
        page = 1; clear(); thread(result);
      } catch (err) {
        if (dialog.open && current === revision) {
          for (const field of form.elements) field.disabled = false;
          errorLine.textContent = boardError(err);
        }
      }
    };
  }

  document.getElementById('developer-contact').onclick = () => { page=1; dialog.showModal(); refresh(); };
  document.getElementById('support-close').onclick = () => dialog.close();
  dialog.addEventListener('close',clear);
  dialog.addEventListener('click',event => { if (event.target === dialog) dialog.close(); });
  client.subscribe(state => {
    if (user === state.user?.id) return;
    user = state.user?.id; page = 1;
    if (dialog.open) refresh();
  });
}
