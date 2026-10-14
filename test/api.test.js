'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { Store } = require('../src/store');

const PASSCODE = 'correct horse battery';

let tmpDir;
let dataFile;
let store;
let server;
let base;
let ownerCookie;

async function call(method, pathname, { body, cookie, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie) init.headers.Cookie = cookie;
  if (method !== 'GET' && !init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(base + pathname, init);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON (HTML page)
  }
  return { status: res.status, data, text, headers: res.headers };
}

const listPath = () => `/api/lists/${store.shareToken}`;

async function addItem(fields, cookie = ownerCookie) {
  const res = await call('POST', `${listPath()}/items`, { body: fields, cookie });
  assert.equal(res.status, 201, res.text);
  return res.data.item;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wishlist-test-'));
  dataFile = path.join(tmpDir, 'registry.json');
  store = new Store(dataFile);
  server = createApp({ store, passcode: PASSCODE, title: 'Test Wishlist' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the list is only reachable with its share token', async () => {
  const wrong = await call('GET', '/api/lists/not-the-token');
  assert.equal(wrong.status, 404);
  assert.match(wrong.data.error, /not valid/);

  const guest = await call('GET', listPath());
  assert.equal(guest.status, 200);
  assert.equal(guest.data.title, 'Test Wishlist');
  assert.equal(guest.data.owner, false);
  assert.deepEqual(guest.data.items, []);
});

test('the list page is served with security headers and no-cache', async () => {
  const res = await call('GET', `/l/${store.shareToken}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.text, /<title>Baby Wishlist<\/title>/);
});

test('owner sign-in rejects a wrong passcode and issues a session cookie', async () => {
  const wrong = await call('POST', '/api/owner/login', { body: { passcode: 'nope' } });
  assert.equal(wrong.status, 401);

  const right = await call('POST', '/api/owner/login', { body: { passcode: PASSCODE } });
  assert.equal(right.status, 200);
  const setCookie = right.headers.get('set-cookie');
  assert.match(setCookie, /^owner_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict/);
  ownerCookie = setCookie.split(';')[0];

  const me = await call('GET', listPath(), { cookie: ownerCookie });
  assert.equal(me.data.owner, true);
});

test('guests cannot add, edit or delete items', async () => {
  const add = await call('POST', `${listPath()}/items`, { body: { name: 'Sneaky' } });
  assert.equal(add.status, 401);
  const edit = await call('PATCH', `${listPath()}/items/whatever`, { body: { name: 'x' } });
  assert.equal(edit.status, 401);
  const del = await call('DELETE', `${listPath()}/items/whatever`);
  assert.equal(del.status, 401);
});

test('owner adds an item; name is required and trimmed', async () => {
  const blank = await call('POST', `${listPath()}/items`, { body: { name: '   ' }, cookie: ownerCookie });
  assert.equal(blank.status, 400);
  assert.match(blank.data.error, /Name is required/);

  const item = await addItem({ name: '  Muslin swaddles  ', notes: 'Grey or white', link: 'example.com/swaddles' });
  assert.equal(item.name, 'Muslin swaddles');
  assert.equal(item.link, 'https://example.com/swaddles');
  assert.equal(item.bought, false);
  assert.equal(item.boughtAt, null);
});

test('links must be http or https', async () => {
  const bad = await call('POST', `${listPath()}/items`, {
    body: { name: 'Evil', link: 'javascript:alert(1)' },
    cookie: ownerCookie,
  });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /http/);

  const ok = await call('POST', `${listPath()}/items`, {
    body: { name: 'Fine', link: 'http://example.com/a' },
    cookie: ownerCookie,
  });
  assert.equal(ok.status, 201);
});

test('owner edits an item; partial edits keep other fields', async () => {
  const item = await addItem({ name: 'Bottle', notes: 'Original' });
  const res = await call('PATCH', `${listPath()}/items/${item.id}`, {
    body: { name: 'Glass bottle' },
    cookie: ownerCookie,
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.item.name, 'Glass bottle');
  assert.equal(res.data.item.notes, 'Original');

  const empty = await call('PATCH', `${listPath()}/items/${item.id}`, { body: {}, cookie: ownerCookie });
  assert.equal(empty.status, 400);
});

test('guests tick an item anonymously; a second tick is refused', async () => {
  const item = await addItem({ name: 'Pram' });

  const first = await call('POST', `${listPath()}/items/${item.id}/bought`);
  assert.equal(first.status, 200);
  assert.equal(first.data.item.bought, true);
  assert.ok(first.data.item.boughtAt);
  assert.equal('buyer' in first.data.item, false);

  const second = await call('POST', `${listPath()}/items/${item.id}/bought`);
  assert.equal(second.status, 409);
  assert.match(second.data.error, /already marked/);
  assert.equal(second.data.item.bought, true);
});

test('only owners can untick an item', async () => {
  const item = await addItem({ name: 'Cot' });
  await call('POST', `${listPath()}/items/${item.id}/bought`);

  const guest = await call('DELETE', `${listPath()}/items/${item.id}/bought`);
  assert.equal(guest.status, 401);

  const owner = await call('DELETE', `${listPath()}/items/${item.id}/bought`, { cookie: ownerCookie });
  assert.equal(owner.status, 200);
  assert.equal(owner.data.item.bought, false);
  assert.equal(owner.data.item.boughtAt, null);
});

test('owner deletes an item', async () => {
  const item = await addItem({ name: 'Temporary' });
  const del = await call('DELETE', `${listPath()}/items/${item.id}`, { cookie: ownerCookie });
  assert.equal(del.status, 200);

  const again = await call('DELETE', `${listPath()}/items/${item.id}`, { cookie: ownerCookie });
  assert.equal(again.status, 404);
});

test('version lets pollers skip unchanged data', async () => {
  const before = await call('GET', listPath());
  const same = await call('GET', `${listPath()}?version=${before.data.version}`);
  assert.equal(same.data.unchanged, true);

  await call('POST', `${listPath()}/items/${before.data.items[0].id}/bought`);
  const after = await call('GET', `${listPath()}?version=${before.data.version}`);
  assert.equal(after.data.unchanged, undefined);
  assert.equal(after.data.version, before.data.version + 1);
});

test('mutations must be sent as JSON', async () => {
  const res = await call('POST', `${listPath()}/items/whatever/bought`, {
    headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal(res.status, 415);
});

test('oversized and malformed bodies are rejected', async () => {
  const huge = await call('POST', '/api/owner/login', { body: JSON.stringify({ passcode: 'x'.repeat(20000) }) });
  assert.equal(huge.status, 413);

  const malformed = await call('POST', '/api/owner/login', { body: '{not json' });
  assert.equal(malformed.status, 400);
});

test('user text is returned as plain data, never as markup', async () => {
  const item = await addItem({ name: '<img src=x onerror=alert(1)>' });
  assert.equal(item.name, '<img src=x onerror=alert(1)>');
});

test('logout ends the owner session', async () => {
  const out = await call('POST', '/api/owner/logout', { cookie: ownerCookie });
  assert.equal(out.status, 200);

  const add = await call('POST', `${listPath()}/items`, { body: { name: 'After logout' }, cookie: ownerCookie });
  assert.equal(add.status, 401);
});

test('data is written to disk and survives a restart', async () => {
  const fresh = new Store(dataFile);
  assert.equal(fresh.shareToken, store.shareToken);
  assert.equal(fresh.state.items.length, store.state.items.length);
  assert.ok(fresh.state.items.some((item) => item.name === 'Glass bottle'));
  assert.ok(!fs.existsSync(`${dataFile}.tmp`));
});
