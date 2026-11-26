import {element,button,meta,pagination,boardRPC,boardError,authorActions} from './board-ui.js';

export function setupCommunityBoard(client, openAccount, route) {
  const body = document.getElementById('community-body');
  const errorLine = document.getElementById('community-error');
  let version = 0, user = client.state.user?.id;
  const actions = (...items) => { const bar=element('div',null,'support-actions'); bar.append(...items); return bar; };
  const active = key => version === key;

  function clear() {
    version++;
    body.replaceChildren(); errorLine.textContent='';
  }
  async function refresh() {
    clear();
    const key = version, id = route.id;
    if (route.compose && !user) {
      body.append(element('p','로그인하면 글과 댓글을 쓸 수 있습니다.'),button('로그인',openAccount,'primary-button'));
      return;
    }
    if (!id && route.compose) { editor(null); return; }
    body.append(element('p','불러오는 중…'));
    try {
      const data = id ? await boardRPC(client,'mighty_community_thread',{p_post:id,p_page:route.comments},!user)
        : await boardRPC(client,'mighty_community_list',{p_page:route.page},true);
      if (!active(key)) return;
      if (data.page>1 && data.page>Math.max(1,Math.ceil(data.total/data.pageSize))) {
        const last = Math.max(1,Math.ceil(data.total/data.pageSize));
        route.go(id ? {comments:last} : {page:last}, true); return;
      }
      clear();
      if (!id) renderList(data);
      else if (route.compose && !data.deleted) editor(data);
      else renderPost(data);
    } catch (error) {
      if (!active(key)) return;
      body.replaceChildren(actions(button('다시 조회',refresh),...(id ? [button('목록으로',back)] : [])));
      errorLine.textContent = boardError(error);
    }
  }
  function back() { route.go({id:null,comments:1}); }
  function renderList(data) {
    body.append(actions(button(user ? '글쓰기' : '로그인하고 글쓰기',() => route.go({compose:true}),'primary-button'),
      button('새로고침',refresh)));
    const list = element('ul',null,'support-rows');
    for (const post of data.items) {
      const row = element('li');
      const open = element('a');
      open.href = route.url({id:post.id,comments:1});
      open.append(element('strong',post.title),meta(post.nickname+' · 댓글 '+post.commentCount+'개',post.createdAt));
      row.append(open); list.append(row);
    }
    body.append(list);
    if (!data.items.length) body.append(element('p','아직 등록된 글이 없습니다.'));
    body.append(pagination(data,p => route.go({page:p})));
  }
  function renderPost(post) {
    document.title = post.title + ' · 자유게시판';
    body.append(actions(button('목록으로',back),button('새로고침',refresh)),element('h3',post.title),
      meta(post.nickname+(post.revision && !post.deleted ? ' · 수정됨' : ''),post.createdAt),element('p',post.body,'post-body'));
    if (post.mine) body.append(manage(post));
    body.append(element('h3','댓글 '+post.total+'개'));
    const list = element('ol',null,'support-messages');
    for (const comment of post.comments) {
      const row = element('li');
      row.append(meta(comment.nickname+(comment.revision ? ' · 수정됨' : ''),comment.createdAt),element('p',comment.body));
      if (comment.mine) row.append(manage(post,comment));
      list.append(row);
    }
    body.append(list,pagination(post,p => route.go({comments:p})));
    if (!post.deleted) body.append(button(user ? '댓글 쓰기' : '로그인하고 댓글 쓰기',() => route.go({compose:true})));
  }
  function manage(post,comment) {
    const item=comment ?? post;
    return authorActions({name:comment ? '댓글' : '게시글',title:comment ? undefined : post.title,
      body:item.body,limit:comment ? 2000 : 4000,
      removal:comment ? '이 댓글을 삭제할까요?' : '이 글의 제목과 내용을 삭제할까요? 이미 달린 댓글은 남습니다.',
      change:args => boardRPC(client,'mighty_community_change',{p_post:post.id,p_comment:comment?.id ?? null,p_revision:item.revision,...args}),
      saved:deleted => { if (deleted && (!comment || (post.deleted && post.total===1))) back(); else refresh(); }
    });
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
    form.append(field,actions(submit,button('취소',() => route.go({},true)))); body.append(form);
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
        route.go({id:data.id,comments:data.page},true);
      } catch(error) {
        if (active(key)) {
          for (const control of form.elements) control.disabled=false;
          errorLine.textContent=boardError(error);
        }
      }
    };
  }
  client.subscribe(state => {
    if (user === state.user?.id) return;
    user=state.user?.id;
    refresh();
  });
  refresh();
  return refresh;
}
