'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 2;
const MAX_SAVE_ATTEMPTS = 5;
const HOLD_MS = 48 * 60 * 60 * 1000;
const CATEGORIES = ['Nursery', 'Clothes', 'Feeding', 'Bath & care', 'Travel', 'Toys', 'Other'];

// The registry is one document. Two places can hold it:
//   FileBackend      a JSON file, for running locally or on a host with a disk
//   SupabaseBackend  a Postgres row, for serverless hosts such as Vercel
// Registry sits on top of either one and does the read-modify-write safely.
//
// Claims on an item come in two kinds:
//   a bought claim   { id, by, at, name }             counts towards "bought"
//   a hold           { id, by, at, expiresAt }        reserves one unit for 48 hours
// `by` is a hash of the browser's device id, never the id itself.

function createInitialState() {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    updatedAt: now,
    list: { shareToken: crypto.randomBytes(18).toString('base64url'), createdAt: now },
    items: [],
  };
}

// Upgrades data written by older versions. Does nothing to current data.
function migrate(state) {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    state.items.forEach(migrateItem);
    state.schemaVersion = SCHEMA_VERSION;
  }
  return state;
}

// Schema 1 stored `bought` and `boughtAt` on each item. Each old tick becomes
// one anonymous claim (no browser), and every item gets quantity 1.
function migrateItem(item) {
  if (!Number.isInteger(item.quantity)) item.quantity = 1;
  if (!Array.isArray(item.claims)) {
    item.claims = item.bought
      ? [{ id: crypto.randomUUID(), by: null, at: item.boughtAt || item.updatedAt }]
      : [];
  }
  delete item.bought;
  delete item.boughtAt;
  return item;
}

function newItem(fields) {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), ...fields, claims: [], createdAt: now, updatedAt: now };
}

function confirmedClaims(item) {
  return item.claims.filter((claim) => !claim.expiresAt);
}

function activeHolds(item, now = Date.now()) {
  return item.claims.filter((claim) => claim.expiresAt && Date.parse(claim.expiresAt) > now);
}

// Drops holds whose time has run out, so they stop counting.
function pruneHolds(item, now = Date.now()) {
  item.claims = item.claims.filter((claim) => !claim.expiresAt || Date.parse(claim.expiresAt) > now);
}

// Only these fields ever leave the server. `mine` and `holding` tell a browser
// whether it made the claim or hold on this item. `boughtBy` (names, or
// "Anonymous") is only added for owners.
function publicItem(item, deviceHash = null, { owner = false, now = Date.now() } = {}) {
  const confirmed = confirmedClaims(item);
  const holds = activeHolds(item, now);
  const soonest = holds.map((hold) => hold.expiresAt).sort()[0] || null;
  const out = {
    id: item.id,
    name: item.name,
    link: item.link,
    notes: item.notes,
    category: item.category || 'Other',
    priority: item.priority === true,
    quantity: item.quantity,
    boughtCount: confirmed.length,
    bought: confirmed.length >= item.quantity,
    reservedCount: holds.length,
    reservedUntil: soonest,
    mine: deviceHash !== null && confirmed.some((claim) => claim.by === deviceHash),
    holding: deviceHash !== null && holds.some((hold) => hold.by === deviceHash),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (owner) out.boughtBy = confirmed.map((claim) => claim.name || 'Anonymous');
  return out;
}

class FileBackend {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async init(makeInitial) {
    if (!fs.existsSync(this.filePath)) await this.save(makeInitial(), null);
  }

  async load() {
    return { state: JSON.parse(fs.readFileSync(this.filePath, 'utf8')), token: null };
  }

  async save(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.filePath);
    return true;
  }
}

// Talks to Supabase's REST API (PostgREST). The table has one row (id = 1)
// and a `rev` column. A save only succeeds if `rev` is still the value we read,
// so two servers can never overwrite each other's changes.
//
// Two keys are sent. The anon key is the public project key, which PostgREST
// needs to accept the request. The registry secret is what row-level security
// checks (see supabase/schema.sql): without it the table reads as empty.
class SupabaseBackend {
  constructor({ url, anonKey, registrySecret, fetchImpl = fetch }) {
    if (!url || !anonKey || !registrySecret) {
      throw new Error('SUPABASE_URL, SUPABASE_ANON_KEY and REGISTRY_SECRET must all be set.');
    }
    this.endpoint = `${url.replace(/\/$/, '')}/rest/v1/registry`;
    this.anonKey = anonKey;
    this.registrySecret = registrySecret;
    this.fetch = fetchImpl;
  }

  headers(extra = {}) {
    return {
      apikey: this.anonKey,
      Authorization: `Bearer ${this.anonKey}`,
      'x-registry-key': this.registrySecret,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async init(makeInitial) {
    if (await this.#row()) return;
    const res = await this.fetch(`${this.endpoint}?on_conflict=id`, {
      method: 'POST',
      headers: this.headers({ Prefer: 'resolution=ignore-duplicates' }),
      body: JSON.stringify({ id: 1, data: makeInitial(), rev: 1 }),
    });
    if (!res.ok) throw new Error(`Storage setup failed (${res.status})`);
  }

  async load() {
    const row = await this.#row();
    // With the wrong registry secret, row-level security hides the row, so both causes look the same.
    if (!row) throw new Error('No registry row is visible. Run supabase/schema.sql and check REGISTRY_SECRET.');
    return { state: row.data, token: row.rev };
  }

  async save(state, rev) {
    const res = await this.fetch(`${this.endpoint}?id=eq.1&rev=eq.${rev}`, {
      method: 'PATCH',
      headers: this.headers({ Prefer: 'return=representation' }),
      body: JSON.stringify({ data: state, rev: rev + 1 }),
    });
    if (!res.ok) throw new Error(`Storage save failed (${res.status})`);
    const rows = await res.json();
    return rows.length === 1; // zero rows means another writer got there first
  }

  async #row() {
    const res = await this.fetch(`${this.endpoint}?id=eq.1&select=data,rev`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Storage read failed (${res.status})`);
    const rows = await res.json();
    return rows[0] || null;
  }
}

class Registry {
  #queue = Promise.resolve();

  constructor(backend) {
    this.backend = backend;
  }

  init() {
    return this.backend.init(createInitialState);
  }

  async read() {
    const { state } = await this.backend.load();
    return migrate(state);
  }

  // Runs mutate(state) on a fresh copy and saves only if something changed.
  // mutate may throw to abort; nothing is saved in that case. Updates in this
  // process run one at a time. Across processes, a conflicting save is retried
  // on fresh data, so mutate can run more than once and must not have side effects.
  update(mutate) {
    const run = this.#queue.then(() => this.#commit(mutate));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #commit(mutate) {
    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
      const { state, token } = await this.backend.load();
      const original = JSON.stringify(state);
      const result = mutate(migrate(state));
      if (JSON.stringify(state) === original) return result;

      state.version += 1;
      state.updatedAt = new Date().toISOString();
      if (await this.backend.save(state, token)) return result;
    }
    throw Object.assign(new Error('The list is busy. Please try again in a moment.'), { status: 503, expose: true });
  }
}

module.exports = {
  Registry,
  FileBackend,
  SupabaseBackend,
  newItem,
  publicItem,
  migrate,
  confirmedClaims,
  activeHolds,
  pruneHolds,
  CATEGORIES,
  HOLD_MS,
};
