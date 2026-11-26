import {accountClient} from './account-client.js';
import {setupAccountUI} from './account-ui.js';
import {setupCommunityBoard} from './community-board.js';
import {setupSupportBoard} from './support-board.js';

const params = new URL(location.href).searchParams;
const board = params.get('board') === 'support' ? 'support' : 'community';
function pageNumber(key) {
  const value = Number(params.get(key));
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}
const route = {
  id:params.get('thread') || null, page:pageNumber('page'), comments:pageNumber('comments'),
  compose:params.get('write') === '1',
  url({id = route.id, page = route.page, comments = route.comments, compose = false} = {}) {
    const url = new URL('./boards.html', location.href);
    url.searchParams.set('board',board);
    if (id) url.searchParams.set('thread',id);
    if (page > 1) url.searchParams.set('page',page);
    if (id && comments > 1) url.searchParams.set('comments',comments);
    if (compose) url.searchParams.set('write','1');
    return url.href;
  },
  go(change, replace = false) {
    const url = route.url(change);
    if (replace) location.replace(url);
    else location.assign(url);
  }
};

const menu = document.getElementById(board === 'support' ? 'developer-contact' : 'community-open');
menu.classList.add('nav-current');
menu.setAttribute('aria-current','page');
document.getElementById(board + '-board').hidden = false;
document.title = menu.textContent + ' · Mighty Club';
const account = setupAccountUI(accountClient);
document.getElementById('profile-btn').onclick = () => account.open();
await accountClient.ready;
const start = board === 'support' ? setupSupportBoard : setupCommunityBoard;
const refresh = start(accountClient, () => account.open(), route);
if (route.compose && !accountClient.state.user) account.open();
window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
// A restored history entry checks the current login before it paints private messages.
window.addEventListener('pagehide', event => {
  if (event.persisted && board === 'support') {
    document.getElementById('support-body').replaceChildren();
    document.getElementById('support-error').textContent = '';
  }
});
