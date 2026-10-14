'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Registry, FileBackend, SupabaseBackend, newItem } = require('../src/store');

const SECRET = 'service-role-test-secret';

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-store-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A small stand-in for Supabase's REST API. It understands only the requests
// SupabaseBackend makes, and applies the same rev check a real row update would.
function fakePostgrest() {
  const state = { row: null, patches: 0, gets: 0, failPatches: 0 };

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    if (req.headers.apikey !== SECRET || req.headers.authorization !== `Bearer ${SECRET}`) {
      return send(res, 401, { message: 'Invalid API key' });
    }
    const url = new URL(req.url, 'http://fake');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;

    if (req.method === 'GET') {
      state.gets += 1;
      return send(res, 200, state.row ? [{ data: state.row.data, rev: state.row.rev }] : []);
    }
    if (req.method === 'POST') {
      if (!state.row) state.row = { id: body.id, data: body.data, rev: body.rev };
      return send(res, 201, []);
    }
    if (req.method === 'PATCH') {
      state.patches += 1;
      if (state.failPatches > 0) {
        state.failPatches -= 1;
        return send(res, 500, { message: 'database unavailable' });
      }
      const expectedRev = Number(url.searchParams.get('rev').replace('eq.', ''));
      if (state.row && state.row.rev === expectedRev) {
        state.row.data = body.data;
        state.row.rev = body.rev;
        return send(res, 200, [{ id: 1, rev: state.row.rev }]);
      }
      return send(res, 200, []); // no row matched: someone else saved first
    }
    return send(res, 405, {});
  });

  return {
    state,
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server))),
    url: () => `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('parallel updates in one process are all kept', async () => {
  const registry = new Registry(new FileBackend(path.join(tmpDir, 'parallel.json')));
  await registry.init();

  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      registry.update((state) => {
        state.items.push(newItem({ name: `Item ${i}`, link: '', notes: '', quantity: 1 }));
      }),
    ),
  );

  const state = await registry.read();
  assert.equal(state.items.length, 25);
  assert.equal(new Set(state.items.map((item) => item.name)).size, 25);
});

test('an update that changes nothing does not bump the version or write', async () => {
  const file = path.join(tmpDir, 'noop.json');
  const registry = new Registry(new FileBackend(file));
  await registry.init();
  const before = (await registry.read()).version;
  const mtime = fs.statSync(file).mtimeMs;

  await registry.update(() => {});

  assert.equal((await registry.read()).version, before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('a mutation that throws saves nothing', async () => {
  const registry = new Registry(new FileBackend(path.join(tmpDir, 'abort.json')));
  await registry.init();

  await assert.rejects(
    registry.update((state) => {
      state.items.push(newItem({ name: 'Should not persist', link: '', notes: '', quantity: 1 }));
      throw Object.assign(new Error('stop'), { expose: true, status: 400 });
    }),
    /stop/,
  );
  assert.equal((await registry.read()).items.length, 0);
});

test('Supabase backend: init creates the row once and keeps existing data', async () => {
  const fake = fakePostgrest();
  await fake.start();
  try {
    const registry = new Registry(new SupabaseBackend({ url: fake.url(), key: SECRET }));
    await registry.init();
    await registry.update((state) => {
      state.items.push(newItem({ name: 'Kept', link: '', notes: '', quantity: 1 }));
    });

    await new Registry(new SupabaseBackend({ url: fake.url(), key: SECRET })).init();
    const state = await registry.read();
    assert.deepEqual(state.items.map((item) => item.name), ['Kept']);
    assert.equal(fake.state.row.rev, 2);
  } finally {
    await fake.close();
  }
});

test('Supabase backend: a save that loses the race is retried on fresh data', async () => {
  const fake = fakePostgrest();
  await fake.start();
  try {
    const registryA = new Registry(new SupabaseBackend({ url: fake.url(), key: SECRET }));
    await registryA.init();
    const registryB = new Registry(new SupabaseBackend({ url: fake.url(), key: SECRET }));

    // Make server A's first read happen, then let server B save before A writes.
    const racing = new SupabaseBackend({ url: fake.url(), key: SECRET });
    const originalLoad = racing.load.bind(racing);
    let interfered = false;
    racing.load = async () => {
      const loaded = await originalLoad();
      if (!interfered) {
        interfered = true;
        await registryB.update((state) => {
          state.items.push(newItem({ name: 'From B', link: '', notes: '', quantity: 1 }));
        });
      }
      return loaded;
    };
    const registryRacing = new Registry(racing);

    let mutatorRuns = 0;
    await registryRacing.update((state) => {
      mutatorRuns += 1;
      state.items.push(newItem({ name: 'From A', link: '', notes: '', quantity: 1 }));
    });

    const names = (await registryA.read()).items.map((item) => item.name).sort();
    assert.deepEqual(names, ['From A', 'From B']);
    assert.equal(mutatorRuns, 2, 'the first attempt lost the race and ran again');
  } finally {
    await fake.close();
  }
});

test('Supabase backend: a failing save reports the status, never the key', async () => {
  const fake = fakePostgrest();
  await fake.start();
  try {
    const registry = new Registry(new SupabaseBackend({ url: fake.url(), key: SECRET }));
    await registry.init();
    fake.state.failPatches = 1;

    await assert.rejects(
      registry.update((state) => {
        state.items.push(newItem({ name: 'x', link: '', notes: '', quantity: 1 }));
      }),
      (err) => {
        assert.match(err.message, /Storage save failed \(500\)/);
        assert.equal(err.message.includes(SECRET), false);
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test('Supabase backend: a wrong key is rejected without echoing it', async () => {
  const fake = fakePostgrest();
  await fake.start();
  try {
    const registry = new Registry(new SupabaseBackend({ url: fake.url(), key: 'the-wrong-key' }));
    await assert.rejects(registry.read(), (err) => {
      assert.match(err.message, /Storage read failed \(401\)/);
      assert.equal(err.message.includes('the-wrong-key'), false);
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('Supabase backend: a missing row points at the schema file', async () => {
  const fake = fakePostgrest();
  await fake.start();
  try {
    const registry = new Registry(new SupabaseBackend({ url: fake.url(), key: SECRET }));
    await assert.rejects(registry.read(), /supabase\/schema\.sql/);
  } finally {
    await fake.close();
  }
});

test('Supabase backend needs both a URL and a key', () => {
  assert.throws(() => new SupabaseBackend({ url: 'https://example.supabase.co', key: '' }), /must both be set/);
  assert.throws(() => new SupabaseBackend({ url: '', key: SECRET }), /must both be set/);
});
