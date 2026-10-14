(() => {
  'use strict';

  const POLL_MS = 10000;
  const DEVICE_KEY = 'wishlist-device-id';
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

  // ---- device id -----------------------------------------------------------
  // A random id kept in this browser. The server stores only a hash of it, so
  // this browser can undo its own ticks without anyone being identified.

  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function loadDeviceId() {
    try {
      const saved = localStorage.getItem(DEVICE_KEY);
      if (saved && /^[A-Za-z0-9_-]{16,100}$/.test(saved)) return saved;
      const fresh = randomId();
      localStorage.setItem(DEVICE_KEY, fresh);
      return fresh;
    } catch {
      return randomId(); // storage blocked: undo works until this page closes
    }
  }

  const deviceId = loadDeviceId();

  // ---- networking ----------------------------------------------------------

  async function api(method, url, body) {
    const headers = { 'X-Device-Id': deviceId };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
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

  // Every call goes to /api/route?p=<path>. See the note in src/app.js.
  const apiUrl = (path, query = '') => `/api/route?p=${encodeURIComponent(path)}${query}`;
  const listPath = () => `lists/${encodeURIComponent(token)}`;
  const itemPath = (id) => `${listPath()}/items/${encodeURIComponent(id)}`;

  // full: true skips the cheap "has anything changed?" check.
  async function refresh({ full = false } = {}) {
    if (!token || stopped) return;
    const seq = ++requestSeq;
    const query = !full && list ? `&version=${list.version}` : '';
    try {
      const data = await api('GET', apiUrl(listPath(), query));
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
        showNoList('This list link is not valid. Check the link you were sent.', `Server replied ${err.status}: ${err.message}`);
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

    // Owners can undo anything. Guests can undo only what their own browser ticked.
    const canUndo = owner || item.mine;
    const multi = item.quantity > 1;

    let marker;
    if (multi) {
      marker = document.createElement('span');
      marker.className = 'count';
      marker.textContent = `${item.boughtCount}/${item.quantity}`;
      marker.setAttribute('aria-hidden', 'true');
    } else {
      marker = document.createElement('input');
      marker.type = 'checkbox';
      marker.className = 'check';
      marker.checked = item.bought;
      marker.disabled = item.bought && !canUndo;
      marker.setAttribute('aria-label', `${item.bought ? 'Bought' : 'Mark as bought'}: ${item.name}`);
      marker.addEventListener('change', () => (marker.checked ? claim(item) : unclaim(item)));
    }

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

    if (multi) {
      const row = document.createElement('div');
      row.className = 'qty-row';
      const text = document.createElement('span');
      text.textContent = `${item.boughtCount} of ${item.quantity} bought`;
      row.append(
        text,
        actionButton('I bought one', () => claim(item), 'primary', item.bought),
        actionButton('Undo', () => unclaim(item), '', !canUndo || item.boughtCount === 0),
      );
      body.append(row);
    }

    if (item.bought) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = multi ? 'All bought' : 'Bought';
      body.append(badge);
    }

    if (owner) {
      const actions = document.createElement('div');
      actions.className = 'item-actions';
      actions.append(actionButton('Edit', () => openEdit(item)), actionButton('Delete', () => removeItem(item), 'danger'));
      body.append(actions);
    }

    li.append(marker, body);
    return li;
  }

  function actionButton(label, onClick, className = '', disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (className) button.className = className;
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
  }

  function renderStatus() {
    if (!list) return;
    els.status.textContent = online
      ? `Last change ${formatTime(list.updatedAt)} · updates automatically`
      : 'Connection lost. Retrying…';
  }

  function showNoList(message, detail = '') {
    els.noList.querySelector('p').textContent = message;
    els.noList.querySelector('#no-list-detail').textContent = detail;
    els.noList.querySelector('#no-list-detail').hidden = !detail;
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

  async function claim(item) {
    try {
      await api('POST', apiUrl(`${itemPath(item.id)}/bought`));
      notify(`Thank you! "${item.name}" is marked as bought.`);
    } catch (err) {
      notify(err.message);
    }
    await refresh({ full: true });
  }

  async function unclaim(item) {
    try {
      await api('DELETE', apiUrl(`${itemPath(item.id)}/bought`));
      notify(`Undone for "${item.name}".`);
    } catch (err) {
      notify(err.message);
    }
    await refresh({ full: true });
  }

  async function removeItem(item) {
    if (!window.confirm(`Delete "${item.name}" from the list?`)) return;
    try {
      await api('DELETE', apiUrl(itemPath(item.id)));
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
    elements.quantity.value = item.quantity;
    elements.link.value = item.link || '';
    elements.notes.value = item.notes || '';
    els.editDialog.showModal();
    elements.name.focus();
  }

  function readItemForm(form) {
    const { elements } = form;
    return {
      name: elements.name.value,
      quantity: elements.quantity.value,
      link: elements.link.value,
      notes: elements.notes.value,
    };
  }

  // ---- owner session -------------------------------------------------------

  els.ownerToggle.addEventListener('click', () => {
    els.loginForm.hidden = !els.loginForm.hidden;
    if (!els.loginForm.hidden) els.loginForm.elements.passcode.focus();
  });

  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('POST', apiUrl('owner/login'), { passcode: els.loginForm.elements.passcode.value });
      els.loginForm.reset();
      notify('Signed in');
    } catch (err) {
      notify(err.message);
    }
    await refresh({ full: true });
  });

  els.logout.addEventListener('click', async () => {
    try {
      await api('POST', apiUrl('owner/logout'), {});
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
      await api('POST', apiUrl(`${listPath()}/items`), readItemForm(els.addForm));
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
      await api('PATCH', apiUrl(itemPath(editingId)), readItemForm(els.editForm));
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
