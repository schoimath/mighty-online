import {element,button,meta,pagination,boardRPC,boardError,authorActions} from './board-ui.js';
const statusLabel = answered => answered ? '답변 완료' : '답변 대기';

export function setupSupportBoard(client, openAccount, route) {
  const body = document.getElementById('support-body');
  const errorLine = document.getElementById('support-error');
  let revision = 0, user = client.state.user?.id;

  function clear() {
    revision++;
    body.replaceChildren();
    errorLine.textContent = '';
  }

  const rpc = (name,args) => boardRPC(client,'mighty_support_'+name,args);

  function refresh() {
    clear();
    if (!user) {
      body.append(element('p','로그인하면 문의를 남기고 답변을 확인할 수 있습니다.'),button('로그인',openAccount,'primary-button'));
      return;
    }
    if (route.id) {
      load('thread',{p_thread:route.id},data => {
        if (route.compose && !data.deleted) compose(data);
        else thread(data);
      }, refresh);
    } else if (route.compose) compose();
    else load('list',{p_page:route.page},list,refresh);
  }

  async function load(name, args, paint, retry) {
    clear();
    const current = revision;
    const progress = element('p','불러오는 중…');
    progress.setAttribute('role','status');
    body.append(progress);
    try {
      const result = await rpc(name,args);
      if (current === revision) { clear(); paint(result); }
    } catch (err) {
      if (current !== revision) return;
      body.replaceChildren(button('다시 조회',retry));
      if (name !== 'list') body.append(button('목록으로',back));
      errorLine.textContent = boardError(err);
    }
  }

  function list(result) {
    if (route.page>1 && !result.items.length) {
      route.go({page:Math.max(1,Math.ceil(result.total/result.pageSize))},true); return;
    }
    const actions = element('div', null, 'support-actions');
    actions.append(button('문의 작성',() => route.go({compose:true}),'primary-button'),button('새로고침',refresh));
    body.append(actions);
    if (!result.items.length) {
      body.append(element('p','등록한 문의가 없습니다.'));
      return;
    }
    const rows = element('ul',null,'support-rows');
    for (const item of result.items) {
      const row = element('li'), open = element('a');
      open.href = route.url({id:item.id});
      open.append(element('strong',item.title),meta(statusLabel(item.answered),item.updatedAt));
      row.append(open); rows.append(row);
    }
    body.append(rows);
    body.append(pagination(result,nextPage => route.go({page:nextPage})));
  }

  function back() { route.go({id:null}); }
  function thread(data) {
    document.title = '비공개 문의 · Mighty Club';
    const actions = element('div',null,'support-actions');
    actions.append(button('목록으로',back),button('새로고침',refresh));
    body.append(actions,element('h3',data.title));
    const messages = element('ol',null,'support-messages');
    for (const message of data.messages) {
      const row = element('li',null,message.isAdmin ? 'admin' : '');
      const writer=message.isAdmin ? '관리자' : '나';
      row.append(meta(writer+(message.revision && !message.deleted ? ' · 수정됨' : ''),message.createdAt),element('p',message.body));
      if (!message.isAdmin && !message.deleted && Number.isInteger(message.revision)) {
        const first=message.id===data.id;
        row.append(authorActions({name:first ? '문의' : '추가 문의',title:first ? data.title : undefined,body:message.body,limit:4000,
          removal:first ? '이 문의의 제목과 내용을 삭제할까요? 추가 문의와 관리자 답변은 남습니다.' : '이 추가 문의를 삭제할까요?',
          change:args => rpc('change',{p_thread:data.id,p_message:message.id,p_revision:message.revision,...args}),
          saved:deleted => {
            if (deleted && (first || data.messages.filter(m=>!m.deleted).length===1)) back();
            else refresh();
          }
        }));
      }
      messages.append(row);
    }
    body.append(messages);
    if (!data.deleted) body.append(button('추가 문의',() => route.go({compose:true})));
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
    const cancel = button('취소',() => route.go({},true));
    actions.append(submit,cancel); form.append(label,actions); body.append(form);
    (title ?? message).focus();
    form.onsubmit = async event => {
      event.preventDefault();
      if (submit.disabled || current !== revision) return;
      const content = message.value.trim(), subject = title?.value.trim();
      if (!content || (title && !subject)) { errorLine.textContent='제목과 내용을 확인해 주세요.'; return; }
      for (const field of form.elements) field.disabled = true;
      errorLine.textContent = '';
      try {
        const result = previous ? await rpc('reply',{p_thread:previous.id,p_message:id,p_body:content})
          : await rpc('create',{p_thread:id,p_title:subject,p_body:content});
        if (current !== revision) return;
        route.go({id:result.id},true);
      } catch (err) {
        if (current === revision) {
          for (const field of form.elements) field.disabled = false;
          errorLine.textContent = boardError(err);
        }
      }
    };
  }

  client.subscribe(state => {
    if (user === state.user?.id) return;
    user = state.user?.id;
    refresh();
  });
  refresh();
  return refresh;
}
