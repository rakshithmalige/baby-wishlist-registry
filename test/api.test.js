'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { Registry, FileBackend } = require('../src/store');

const PASSCODE = 'correct horse battery';
const DEVICE_A = 'device-a-0123456789abcdef';
const DEVICE_B = 'device-b-0123456789abcdef';
const DEVICE_C = 'device-c-0123456789abcdef';

let tmpDir;
let dataFile;
let store;
let shareToken;
let server;
let base;
let ownerCookie;

// Sends a request. Non-GET requests are sent as JSON unless a content type is given.
async function request(origin, method, pathname, { body, cookie, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie) init.headers.Cookie = cookie;
  if (method !== 'GET' && !init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(origin + pathname, init);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON (the HTML page)
  }
  return { status: res.status, data, text, headers: res.headers };
}

const call = (method, pathname, options) => request(base, method, pathname, options);
const listPath = () => `/api/lists/${shareToken}`;
const device = (id) => ({ 'X-Device-Id': id });

async function addItem(fields, cookie = ownerCookie) {
  const res = await call('POST', `${listPath()}/items`, { body: fields, cookie });
  assert.equal(res.status, 201, res.text);
  return res.data.item;
}

function tick(itemId, deviceId) {
  return call('POST', `${listPath()}/items/${itemId}/bought`, { headers: device(deviceId) });
}

function undo(itemId, { deviceId, cookie } = {}) {
  return call('DELETE', `${listPath()}/items/${itemId}/bought`, {
    headers: deviceId ? device(deviceId) : {},
    cookie,
  });
}

// A correctly signed owner cookie with a chosen expiry, to test the cookie check.
function signedCookie(expiresAt, passcode = PASSCODE) {
  const mac = crypto.createHmac('sha256', passcode).update(`owner-session:${expiresAt}`).digest('base64url');
  return `owner_session=${expiresAt}.${mac}`;
}

async function startApp(options) {
  const app = http.createServer(createApp(options));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  return { origin, close: () => new Promise((resolve) => app.close(resolve)) };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
  dataFile = path.join(tmpDir, 'registry.json');
  store = new Registry(new FileBackend(dataFile));
  await store.init();
  shareToken = (await store.read()).list.shareToken;
  server = http.createServer(createApp({ store, passcode: PASSCODE, title: 'Test Registry' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- Sprint 1: MVP --------------------------------------------------------

test('the list is only reachable with its share token', async () => {
  const wrong = await call('GET', '/api/lists/not-the-token');
  assert.equal(wrong.status, 404);
  assert.match(wrong.data.error, /not valid/);

  const guest = await call('GET', listPath());
  assert.equal(guest.status, 200);
  assert.equal(guest.data.title, 'Test Registry');
  assert.equal(guest.data.owner, false);
  assert.deepEqual(guest.data.items, []);
});

test('the list page is served with security headers and no-cache', async () => {
  const res = await call('GET', `/l/${shareToken}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.text, /<title>Baby Registry<\/title>/);
});

test('owner sign-in rejects a wrong passcode and issues a session cookie', async () => {
  const wrong = await call('POST', '/api/owner/login', { body: { passcode: 'nope' } });
  assert.equal(wrong.status, 401);

  const right = await call('POST', '/api/owner/login', { body: { passcode: PASSCODE } });
  assert.equal(right.status, 200);
  const setCookie = right.headers.get('set-cookie');
  assert.match(setCookie, /^owner_session=\d+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict/);
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

test('forged, expired and wrongly signed cookies are rejected', async () => {
  const past = Date.now() - 60_000;
  const cases = {
    'forged signature': `owner_session=${Date.now() + 60_000}.not-a-real-signature`,
    expired: signedCookie(past),
    'signed with another passcode': signedCookie(Date.now() + 60_000, 'another passcode entirely'),
    'no expiry': 'owner_session=abc.def',
  };
  for (const [label, cookie] of Object.entries(cases)) {
    const res = await call('POST', `${listPath()}/items`, { body: { name: 'x' }, cookie });
    assert.equal(res.status, 401, `${label} should be rejected`);
  }

  const valid = await call('POST', `${listPath()}/items`, {
    body: { name: 'Signed by hand' },
    cookie: signedCookie(Date.now() + 60_000),
  });
  assert.equal(valid.status, 201, 'a correctly signed, unexpired cookie is accepted');
});

test('owner adds an item; name is required and trimmed', async () => {
  const blank = await call('POST', `${listPath()}/items`, { body: { name: '   ' }, cookie: ownerCookie });
  assert.equal(blank.status, 400);
  assert.match(blank.data.error, /Name is required/);

  const item = await addItem({ name: '  Muslin swaddles  ', notes: 'Grey or white', link: 'example.com/swaddles' });
  assert.equal(item.name, 'Muslin swaddles');
  assert.equal(item.link, 'https://example.com/swaddles');
  assert.equal(item.quantity, 1);
  assert.equal(item.bought, false);
  assert.equal(item.boughtCount, 0);
  assert.equal(item.mine, false);
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

  const first = await tick(item.id, DEVICE_A);
  assert.equal(first.status, 200);
  assert.equal(first.data.item.bought, true);
  assert.equal(first.data.item.boughtCount, 1);
  assert.equal(JSON.stringify(first.data).includes(DEVICE_A), false, 'device id must never be returned');
  assert.equal('by' in first.data.item, false);
  assert.equal('claims' in first.data.item, false);

  const second = await tick(item.id, DEVICE_B);
  assert.equal(second.status, 409);
  assert.match(second.data.error, /already marked/);
  assert.equal(second.data.item.bought, true);
});

test('only owners, or the browser that ticked, can untick', async () => {
  const item = await addItem({ name: 'Cot' });
  await tick(item.id, DEVICE_A);

  const stranger = await undo(item.id, { deviceId: DEVICE_B });
  assert.equal(stranger.status, 403);

  const anonymous = await undo(item.id);
  assert.equal(anonymous.status, 403, 'a guest with no device id has nothing to undo');

  const owner = await undo(item.id, { cookie: ownerCookie });
  assert.equal(owner.status, 200);
  assert.equal(owner.data.item.bought, false);
  assert.equal(owner.data.item.boughtCount, 0);
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

  await tick(before.data.items[0].id, DEVICE_C);
  const after = await call('GET', `${listPath()}?version=${before.data.version}`);
  assert.equal(after.data.unchanged, undefined);
  assert.equal(after.data.version, before.data.version + 1);
});

test('mutations must be sent as JSON', async () => {
  const res = await call('POST', `${listPath()}/items/whatever/bought`, {
    headers: { 'Content-Type': 'text/plain', ...device(DEVICE_A) },
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

test('the health check reads the registry and reports ok', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true });
});

test('API calls also work through the single-segment route the page uses', async () => {
  const list = await call('GET', `/api/route?p=${encodeURIComponent(`lists/${shareToken}`)}`);
  assert.equal(list.status, 200);
  assert.equal(list.data.title, 'Test Registry');

  const login = await call('POST', `/api/route?p=${encodeURIComponent('owner/login')}`, {
    body: { passcode: PASSCODE },
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /owner_session=/);
});

// ---- Sprint 2: undo, quantities, rate limits ------------------------------

test('a browser sees which items it ticked, so it can offer an undo', async () => {
  const item = await addItem({ name: 'Bibs' });
  await tick(item.id, DEVICE_A);

  const mine = await call('GET', listPath(), { headers: device(DEVICE_A) });
  assert.equal(mine.data.items.find((i) => i.id === item.id).mine, true);

  const other = await call('GET', listPath(), { headers: device(DEVICE_B) });
  assert.equal(other.data.items.find((i) => i.id === item.id).mine, false);
});

test('a guest can undo their own tick and nobody else can', async () => {
  const item = await addItem({ name: 'Blanket' });
  await tick(item.id, DEVICE_A);

  const other = await undo(item.id, { deviceId: DEVICE_B });
  assert.equal(other.status, 403);
  assert.match(other.data.error, /ticked this can undo/);

  const own = await undo(item.id, { deviceId: DEVICE_A });
  assert.equal(own.status, 200);
  assert.equal(own.data.item.bought, false);

  const nothingLeft = await undo(item.id, { deviceId: DEVICE_A });
  assert.equal(nothingLeft.status, 403);
});

test('ticks require a device id', async () => {
  const item = await addItem({ name: 'Rattle' });
  const res = await call('POST', `${listPath()}/items/${item.id}/bought`);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /device/);
});

test('quantity: an item is bought only once every unit is claimed', async () => {
  const item = await addItem({ name: 'Bodysuits', quantity: 3 });
  assert.equal(item.quantity, 3);

  const one = await tick(item.id, DEVICE_A);
  assert.equal(one.data.item.bought, false);
  assert.equal(one.data.item.boughtCount, 1);

  await tick(item.id, DEVICE_B);
  const three = await tick(item.id, DEVICE_C);
  assert.equal(three.data.item.bought, true);
  assert.equal(three.data.item.boughtCount, 3);

  const four = await tick(item.id, 'device-d-0123456789abcdef');
  assert.equal(four.status, 409);
  assert.match(four.data.error, /All of these have already been bought/);
});

test('quantity is validated: whole numbers from 1 to 20', async () => {
  for (const quantity of [0, 21, 1.5, 'lots', true]) {
    const res = await call('POST', `${listPath()}/items`, {
      body: { name: 'Bad quantity', quantity },
      cookie: ownerCookie,
    });
    assert.equal(res.status, 400, `quantity ${JSON.stringify(quantity)} should be rejected`);
    assert.match(res.data.error, /Quantity must be a whole number/);
  }

  const asText = await addItem({ name: 'Text quantity', quantity: '4' });
  assert.equal(asText.quantity, 4);
});

test('owner cannot lower quantity below the number already bought', async () => {
  const item = await addItem({ name: 'Socks', quantity: 4 });
  await tick(item.id, DEVICE_A);
  await tick(item.id, DEVICE_B);

  const tooLow = await call('PATCH', `${listPath()}/items/${item.id}`, {
    body: { quantity: 1 },
    cookie: ownerCookie,
  });
  assert.equal(tooLow.status, 400);
  assert.match(tooLow.data.error, /already bought/);

  const exact = await call('PATCH', `${listPath()}/items/${item.id}`, {
    body: { quantity: 2 },
    cookie: ownerCookie,
  });
  assert.equal(exact.status, 200);
  assert.equal(exact.data.item.bought, true);
});

test('owner undo removes the most recent claim, whichever browser made it', async () => {
  const item = await addItem({ name: 'Towels', quantity: 2 });
  await tick(item.id, DEVICE_A);
  await tick(item.id, DEVICE_B);

  const res = await undo(item.id, { cookie: ownerCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.item.boughtCount, 1);

  // DEVICE_A's claim is the older one, so it survives the owner's undo.
  const stillMine = await call('GET', listPath(), { headers: device(DEVICE_A) });
  assert.equal(stillMine.data.items.find((i) => i.id === item.id).mine, true);
});

test('owner undo on an item with nothing bought is a clear error', async () => {
  const item = await addItem({ name: 'Untouched' });
  const res = await undo(item.id, { cookie: ownerCookie });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /Nothing to undo/);
});

test('data is written to disk and survives a restart', async () => {
  const fresh = new Registry(new FileBackend(dataFile));
  const state = await fresh.read();
  assert.equal(state.list.shareToken, shareToken);
  assert.ok(state.items.some((item) => item.name === 'Glass bottle'));
  assert.ok(!fs.existsSync(`${dataFile}.tmp`));
});

test('schema 1 data (bought flags) migrates to quantity and claims', async () => {
  const legacyFile = path.join(tmpDir, 'legacy.json');
  const now = '2026-10-01T00:00:00.000Z';
  fs.writeFileSync(
    legacyFile,
    JSON.stringify({
      version: 5,
      updatedAt: now,
      list: { shareToken: 'legacy-token-0123456789', createdAt: now },
      items: [
        { id: 'a', name: 'Cot', link: '', notes: '', bought: true, boughtAt: now, createdAt: now, updatedAt: now },
        { id: 'b', name: 'Pram', link: '', notes: '', bought: false, boughtAt: null, createdAt: now, updatedAt: now },
      ],
    }),
  );

  const migrated = new Registry(new FileBackend(legacyFile));
  const [cot, pram] = (await migrated.read()).items;

  assert.equal(cot.quantity, 1);
  assert.equal(cot.claims.length, 1);
  assert.equal(cot.claims[0].by, null, 'legacy ticks have no browser to undo from');
  assert.equal('bought' in cot, false);
  assert.equal('boughtAt' in cot, false);
  assert.deepEqual(pram.claims, []);

  // Reading does not write. The first real update saves the migrated data.
  assert.equal(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).schemaVersion, undefined);
  await migrated.update(() => {});
  const onDisk = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  assert.equal(onDisk.schemaVersion, 2);
  assert.equal(onDisk.items[0].claims.length, 1);
});

test('the sign-in endpoint is rate limited per IP', async () => {
  const limited = await startApp({
    store: new Registry(new FileBackend(path.join(tmpDir, 'limit-login.json'))),
    passcode: PASSCODE,
    limits: { loginAttempts: { max: 3, windowMs: 60_000 } },
  });
  try {
    const attempt = () => request(limited.origin, 'POST', '/api/owner/login', { body: { passcode: 'nope' } });
    for (let i = 0; i < 3; i += 1) assert.equal((await attempt()).status, 401);

    const blocked = await attempt();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally {
    await limited.close();
  }
});

test('ticks are rate limited per IP', async () => {
  const limitedStore = new Registry(new FileBackend(path.join(tmpDir, 'limit-ticks.json')));
  await limitedStore.init();
  const limited = await startApp({
    store: limitedStore,
    passcode: PASSCODE,
    limits: { ticks: { max: 2, windowMs: 60_000 } },
  });
  try {
    const login = await request(limited.origin, 'POST', '/api/owner/login', { body: { passcode: PASSCODE } });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const token = (await limitedStore.read()).list.shareToken;

    const add = await request(limited.origin, 'POST', `/api/lists/${token}/items`, {
      body: { name: 'Many', quantity: 10 },
      cookie,
    });
    const claim = (deviceId) =>
      request(limited.origin, 'POST', `/api/lists/${token}/items/${add.data.item.id}/bought`, {
        headers: device(deviceId),
      });

    assert.equal((await claim(DEVICE_A)).status, 200);
    assert.equal((await claim(DEVICE_B)).status, 200);
    const third = await claim(DEVICE_C);
    assert.equal(third.status, 429);
    assert.ok(third.headers.get('retry-after'));
  } finally {
    await limited.close();
  }
});

test('behind a proxy, rate limits follow X-Forwarded-For', async () => {
  const proxied = await startApp({
    store: new Registry(new FileBackend(path.join(tmpDir, 'proxied.json'))),
    passcode: PASSCODE,
    trustProxy: true,
    limits: { loginAttempts: { max: 2, windowMs: 60_000 } },
  });
  try {
    const attempt = (ip) =>
      request(proxied.origin, 'POST', '/api/owner/login', {
        body: { passcode: 'nope' },
        headers: { 'X-Forwarded-For': ip },
      });
    assert.equal((await attempt('10.0.0.1')).status, 401);
    assert.equal((await attempt('10.0.0.1')).status, 401);
    assert.equal((await attempt('10.0.0.1')).status, 429);
    assert.equal((await attempt('10.0.0.2')).status, 401, 'a different client is not blocked');
  } finally {
    await proxied.close();
  }
});

test('logout clears the cookie in this browser', async () => {
  const out = await call('POST', '/api/owner/logout', { cookie: ownerCookie });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /owner_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
});

test('changing the passcode signs out every existing session', async () => {
  const cookie = signedCookie(Date.now() + 60_000, PASSCODE);
  const rotated = await startApp({ store, passcode: 'a brand new passcode', title: 'Test Registry' });
  try {
    const res = await request(rotated.origin, 'POST', `${listPath()}/items`, { body: { name: 'Nope' }, cookie });
    assert.equal(res.status, 401);
  } finally {
    await rotated.close();
  }
});
