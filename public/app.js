(() => {
  'use strict';

  const POLL_MS = 10000;
  const tokenMatch = location.pathname.match(/^\/l\/([A-Za-z0-9_-]+)\/?$/);
  const token = tokenMatch ? tokenMatch[1] : null;
  const $ = (id) => document.getElementById(id);

  const els = {
    title: $('title'),
    progress: $('progress'),
    status: $('status'),
    noList: $('no-list'),
    loginForm: $('login-form'),
    addForm: $('add-form'),
    items: $('items'),
    empty: $('empty'),
    ownerToggle: $('owner-toggle'),
    ownerTools: $('owner-tools'),
    copyLink: $('copy-link'),
    logout: $('logout'),
    editDialog: $('edit-dialog'),
    editForm: $('edit-form'),
    editCancel: $('edit-cancel'),
    notice: $('notice'),
  };

  let list = null; // last full list from the server
  let requestSeq = 0; // lets us ignore responses that arrive out of order
  let online = true;
  let stopped = false;
  let editingId = null;
  let noticeTimer = null;

  // ---- networking ----------------------------------------------------------

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `Request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  const listUrl = () => `/api/lists/${encodeURIComponent(token)}`;
  const itemUrl = (id) => `${listUrl()}/items/${encodeURIComponent(id)}`;

  // full: true skips the cheap "has anything changed?" check.
  async function refresh({ full = false } = {}) {
    if (!token || stopped) return;
    const seq = ++requestSeq;
    const query = !full && list ? `?version=${list.version}` : '';
    try {
      const data = await api('GET', listUrl() + query);
      if (seq !== requestSeq) return;
      online = true;
      if (!data.unchanged) {
        list = data;
        render();
      }
      renderStatus();
    } catch (err) {
      if (seq !== requestSeq) return;
      if (err.status === 404) {
        stopped = true;
        showNoList('This list link is not valid. Check the link you were sent.');
        return;
      }
      online = false;
      renderStatus();
    }
  }

  // ---- rendering -----------------------------------------------------------

  function render() {
    const { items, owner } = list;
    const boughtCount = items.filter((item) => item.bought).length;

    els.title.textContent = list.title;
    document.title = list.title;
    els.progress.textContent = items.length ? `${boughtCount} of ${items.length} gifts bought` : '';

    // Still-needed items first, bought ones sink to the bottom.
    const ordered = [...items.filter((item) => !item.bought), ...items.filter((item) => item.bought)];
    els.items.replaceChildren(...ordered.map((item) => renderItem(item, owner)));
    els.items.hidden = items.length === 0;

    els.empty.textContent = owner ? 'No gifts yet. Add the first one below.' : 'No gifts on the list yet.';
    els.empty.hidden = items.length !== 0;

    els.addForm.hidden = !owner;
    if (owner) els.loginForm.hidden = true;
    els.ownerToggle.hidden = owner;
    els.ownerTools.hidden = !owner;
  }

  function renderItem(item, owner) {
    const li = document.createElement('li');
    li.className = item.bought ? 'item is-bought' : 'item';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'check';
    check.checked = item.bought;
    // Guests can tick but not untick. Owners can do both.
    check.disabled = item.bought && !owner;
    check.setAttribute('aria-label', `${item.bought ? 'Bought' : 'Mark as bought'}: ${item.name}`);
    check.addEventListener('change', () => toggleBought(item, check.checked));

    const body = document.createElement('div');
    body.className = 'item-body';

    const name = document.createElement('p');
    name.className = 'item-name';
    if (isWebLink(item.link)) {
      const a = document.createElement('a');
      a.href = item.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = item.name;
      name.append(a);
    } else {
      name.textContent = item.name;
    }
    body.append(name);

    if (item.notes) {
      const notes = document.createElement('p');
      notes.className = 'item-notes';
      notes.textContent = item.notes;
      body.append(notes);
    }

    if (item.bought) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Bought';
      body.append(badge);
    }

    if (owner) {
      const actions = document.createElement('div');
      actions.className = 'item-actions';
      actions.append(
        actionButton('Edit', () => openEdit(item)),
        actionButton('Delete', () => removeItem(item), 'danger'),
      );
      body.append(actions);
    }

    li.append(check, body);
    return li;
  }

  function actionButton(label, onClick, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener('click', onClick);
    return button;
  }

  function renderStatus() {
    if (!list) return;
    els.status.textContent = online
      ? `Last change ${formatTime(list.updatedAt)} · updates automatically`
      : 'Connection lost. Retrying…';
  }

  function showNoList(message) {
    els.noList.querySelector('p').textContent = message;
    els.noList.hidden = false;
    els.progress.hidden = true;
    els.status.hidden = true;
    els.ownerToggle.hidden = true;
  }

  function notify(message) {
    els.notice.textContent = message;
    els.notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      els.notice.hidden = true;
    }, 4000);
  }

  // ---- actions -------------------------------------------------------------

  async function toggleBought(item, checked) {
    try {
      await api(checked ? 'POST' : 'DELETE', `${itemUrl(item.id)}/bought`);
      notify(checked ? `Thank you! "${item.name}" is marked as bought.` : `"${item.name}" is back on the list.`);
    } catch (err) {
      notify(err.message);
    }
    await refresh({ full: true });
  }

  async function removeItem(item) {
    if (!window.confirm(`Delete "${item.name}" from the list?`)) return;
    try {
      await api('DELETE', itemUrl(item.id));
      notify('Item deleted');
    } catch (err) {
      notify(err.message);
    }
    await refresh({ full: true });
  }

  function openEdit(item) {
    editingId = item.id;
    const { elements } = els.editForm;
    elements.name.value = item.name;
    elements.link.value = item.link || '';
    elements.notes.value = item.notes || '';
    els.editDialog.showModal();
    elements.name.focus();
  }

  function readItemForm(form) {
    const { elements } = form;
    return { name: elements.name.value, link: elements.link.value, notes: elements.notes.value };
  }

  // ---- owner session -------------------------------------------------------

  els.ownerToggle.addEventListener('click', () => {
    els.loginForm.hidden = !els.loginForm.hidden;
    if (!els.loginForm.hidden) els.loginForm.elements.passcode.focus();
  });

  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('POST', '/api/owner/login', { passcode: els.loginForm.elements.passcode.value });
      els.loginForm.reset();
      notify('Signed in');
    } catch (err) {
      notify(err.message);
    }
    await refresh({ full: true });
  });

  els.logout.addEventListener('click', async () => {
    try {
      await api('POST', '/api/owner/logout', {});
      notify('Signed out');
    } catch (err) {
      notify(err.message);
    }
    await refresh({ full: true });
  });

  els.copyLink.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      notify('Share link copied');
    } catch {
      window.prompt('Copy the share link:', location.href);
    }
  });

  // ---- add and edit -------------------------------------------------------

  els.addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('POST', `${listUrl()}/items`, readItemForm(els.addForm));
      els.addForm.reset();
      notify('Added to the list');
    } catch (err) {
      notify(err.message);
    }
    await refresh({ full: true });
  });

  els.editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('PATCH', itemUrl(editingId), readItemForm(els.editForm));
      els.editDialog.close();
      notify('Changes saved');
    } catch (err) {
      notify(err.message);
    }
    await refresh({ full: true });
  });

  els.editCancel.addEventListener('click', () => els.editDialog.close());

  // ---- helpers -------------------------------------------------------------

  function isWebLink(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value);
  }

  function formatTime(iso) {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  // ---- start ---------------------------------------------------------------

  if (!token) {
    showNoList('Open the share link you were sent to see the list.');
    return;
  }

  refresh({ full: true });
  setInterval(() => {
    if (!document.hidden) refresh();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
})();
