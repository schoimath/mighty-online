const number = new Intl.NumberFormat('ko-KR');

export function setupChipLeaderboard(section, client) {
  const table = section.querySelector('table'), body = table.tBodies[0];
  const status = section.querySelector('#rank-status'), nav = section.querySelector('nav');
  const refreshButton = section.querySelector('#rank-refresh');
  const prev = section.querySelector('#rank-prev'), next = section.querySelector('#rank-next');
  let page = 1, pages = 1, lastAttempt = 0, pending = false;

  function render(data) {
    const rows = document.createDocumentFragment();
    for (const member of data.items) {
      const row = document.createElement('tr');
      row.dataset.rank = member.rank;
      row.insertCell().textContent = (member.tied ? '공동 ' : '') + number.format(member.rank) + '위';
      const nickname = document.createElement('th');
      nickname.scope = 'row';
      nickname.textContent = member.nickname;
      row.append(nickname);
      row.insertCell().textContent = number.format(BigInt(member.balance));
      rows.append(row);
    }
    body.replaceChildren(rows);
    page = data.page;
    pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    table.hidden = !data.items.length;
    status.hidden = !table.hidden;
    status.textContent = table.hidden ? '아직 순위에 오른 회원이 없습니다.' : '';
    nav.hidden = pages === 1;
    section.querySelector('#rank-page').textContent = page + ' / ' + pages;
  }

  async function refresh(target = page) {
    if (pending) return;
    pending = true;
    lastAttempt = Date.now();
    refreshButton.disabled = prev.disabled = next.disabled = true;
    section.setAttribute('aria-busy','true');
    try {
      const response = await fetch(client.url + '/rest/v1/rpc/mighty_chip_leaderboard', {
        method:'POST', headers:{apikey:client.publishableKey, 'Content-Type':'application/json'},
        body:JSON.stringify({p_page:target}), cache:'no-store', redirect:'error', signal:AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error();
      render(await response.json());
    } catch {
      status.textContent = '순위를 불러오지 못했습니다. 새로고침해 주세요.';
      status.hidden = false;
    } finally {
      pending = false;
      section.removeAttribute('aria-busy');
      refreshButton.disabled = false;
      prev.disabled = page <= 1;
      next.disabled = page >= pages;
    }
  }

  refreshButton.onclick = () => refresh();
  prev.onclick = () => refresh(page - 1);
  next.onclick = () => refresh(page + 1);
  return {refresh, refreshIfStale() { if (Date.now() - lastAttempt >= 60000) return refresh(); }};
}
