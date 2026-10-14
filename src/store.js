'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 2;

// Single JSON file holding the one list. Reads come from memory; every change
// is written to a temp file and renamed over the real one, so a crash never
// leaves half-written data behind.
//
// Each item has a quantity and a list of claims ("I bought one"). A claim
// records a hash of the browser that made it, never the browser id itself.
class Store {
  constructor(filePath) {
    this.filePath = filePath;
    if (fs.existsSync(filePath)) {
      this.state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (this.state.schemaVersion !== SCHEMA_VERSION) {
        this.state.items.forEach(migrateItem);
        this.state.schemaVersion = SCHEMA_VERSION;
        this.#write();
      }
    } else {
      const now = new Date().toISOString();
      this.state = {
        schemaVersion: SCHEMA_VERSION,
        version: 1,
        updatedAt: now,
        list: { shareToken: crypto.randomBytes(18).toString('base64url'), createdAt: now },
        items: [],
      };
      this.#write();
    }
  }

  get shareToken() {
    return this.state.list.shareToken;
  }

  snapshot(deviceHash) {
    return {
      version: this.state.version,
      updatedAt: this.state.updatedAt,
      items: this.state.items.map((item) => publicItem(item, deviceHash)),
    };
  }

  findItem(id) {
    return this.state.items.find((item) => item.id === id) || null;
  }

  addItem({ name, link, notes, quantity }) {
    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      name,
      link,
      notes,
      quantity,
      claims: [],
      createdAt: now,
      updatedAt: now,
    };
    this.state.items.push(item);
    this.#commit();
    return item;
  }

  updateItem(item, fields) {
    Object.assign(item, fields, { updatedAt: new Date().toISOString() });
    this.#commit();
    return item;
  }

  deleteItem(item) {
    this.state.items = this.state.items.filter((other) => other.id !== item.id);
    this.#commit();
  }

  #commit() {
    this.state.version += 1;
    this.state.updatedAt = new Date().toISOString();
    this.#write();
  }

  #write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
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

// Only these fields ever leave the server. `mine` tells a browser whether it
// made any of the claims on this item, so it can offer an undo.
function publicItem(item, deviceHash = null) {
  return {
    id: item.id,
    name: item.name,
    link: item.link,
    notes: item.notes,
    quantity: item.quantity,
    boughtCount: item.claims.length,
    bought: item.claims.length >= item.quantity,
    mine: deviceHash !== null && item.claims.some((claim) => claim.by === deviceHash),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

module.exports = { Store, publicItem };
