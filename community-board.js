import {element,button,meta,pagination,boardRPC,boardError} from './board-ui.js';

export function setupCommunityBoard(client, openAccount) {
  const dialog = document.getElementById('community-dialog');
  const body = document.getElementById('community-body');
  const errorLine = document.getElementById('community-error');
  let version = 0, page = 1, currentPost = null, commentPage = 1, user = client.state.user?.id;
  const actions = (...items) => { const bar=element('div',null,'support-actions'); bar.append(...items); return bar; };
  const active = key => dialog.open && version === key;

  function clear() {
    version++;
    body.replaceChildren(); errorLine.textContent=''; dialog.scrollTop=0;
  }
  async function refresh() {
    clear();
    const key = version, id = currentPost;
    body.append(element('p','불러오는 중…'));
    try {
      const data = id ? await boardRPC(client,'mighty_community_thread',{p_post:id,p_page:commentPage},true)
        : await boardRPC(client,'mighty_community_list',{p_page:page},true);
      if (!active(key)) return;
      clear();
      if (id) renderPost(data); else renderList(data);
    } catch (error) {
      if (!active(key)) return;
      body.replaceChildren(actions(button('다시 조회',refresh),...(id ? [button('목록으로',back)] : [])));
      errorLine.textContent = boardError(error);
    }
  }
  function back() { currentPost = null; refresh(); }
  function renderList(data) {
    body.append(actions(button(user ? '글쓰기' : '로그인하고 글쓰기',user ? () => editor(null) : openAccount,'primary-button'),
      button('새로고침',refresh)));
    const list = element('ul',null,'support-rows');
    for (const post of data.items) {
      const row = element('li');
      const open = button('',() => {currentPost=post.id; commentPage=1; refresh();},'');
      open.append(element('strong',post.title),meta(post.nickname+' · 댓글 '+post.commentCount+'개',post.createdAt));
      row.append(open); list.append(row);
    }
    body.append(list);
    if (!data.items.length) body.append(element('p','아직 등록된 글이 없습니다.'));
    body.append(pagination(data,p => { page=p; refresh(); }));
  }
  function renderPost(post) {
    body.append(actions(button('목록으로',back),button('새로고침',refresh)),element('h3',post.title),
      meta(post.nickname,post.createdAt),element('p',post.body,'post-body'),element('h3','댓글 '+post.total+'개'));
    const list = element('ol',null,'support-messages');
    for (const comment of post.comments) {
      const row = element('li');
      row.append(meta(comment.nickname,comment.createdAt),element('p',comment.body));
      list.append(row);
    }
    body.append(list,pagination(post,p => {commentPage=p; refresh();}),
      button(user ? '댓글 쓰기' : '로그인하고 댓글 쓰기',user ? () => editor(post) : openAccount));
  }
  function editor(post) {
    clear();
    const key = version, request = crypto.randomUUID(), form = element('form');
    const subject = element('input');
    body.append(element('h3',post ? post.title : '자유게시판 글쓰기'));
    if (!post) {
      const field=element('label','제목','field');
      subject.maxLength=100; subject.required=true; field.append(subject); form.append(field);
    }
    const field=element('label',post ? '댓글' : '내용','field'), text=element('textarea');
    text.rows=post ? 3 : 6; text.maxLength=post ? 2000 : 4000; text.required=true; field.append(text);
    const submit=element('button','공개 등록','primary-button'); submit.type='submit';
    form.append(field,actions(submit,button('취소',refresh))); body.append(form);
    (post ? text : subject).focus();
    form.onsubmit = async event => {
      event.preventDefault();
      if (!active(key) || submit.disabled) return;
      const content=text.value.trim(), title=subject.value.trim();
      if (!content || (!post && !title)) { errorLine.textContent='작성 내용을 확인해 주세요.'; return; }
      for (const control of form.elements) control.disabled=true;
      errorLine.textContent='';
      try {
        const data = post ? await boardRPC(client,'mighty_community_comment',{p_post:post.id,p_request:request,p_body:content})
          : await boardRPC(client,'mighty_community_create',{p_request:request,p_title:title,p_body:content});
        if (!active(key)) return;
        currentPost=data.id; commentPage=data.page; page=1; clear(); renderPost(data);
      } catch(error) {
        if (active(key)) {
          for (const control of form.elements) control.disabled=false;
          errorLine.textContent=boardError(error);
        }
      }
    };
  }
  document.getElementById('community-open').onclick = () => {
    currentPost=null; page=1; dialog.showModal(); refresh();
  };
  document.getElementById('community-close').onclick = () => dialog.close();
  dialog.addEventListener('click',event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close',clear);
  client.subscribe(state => {
    if (user === state.user?.id) return;
    user=state.user?.id;
    if (dialog.open) refresh();
  });
}
