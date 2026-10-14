'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Single JSON file holding the one list. Reads come from memory; every change
// is written to a temp file and renamed over the real one, so a crash never
// leaves half-written data behind.
class Store {
  constructor(filePath) {
    this.filePath = filePath;
    if (fs.existsSync(filePath)) {
      this.state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } else {
      const now = new Date().toISOString();
      this.state = {
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

  snapshot() {
    return {
      version: this.state.version,
      updatedAt: this.state.updatedAt,
      items: this.state.items.map(publicItem),
    };
  }

  findItem(id) {
    return this.state.items.find((item) => item.id === id) || null;
  }

  addItem({ name, link, notes }) {
    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      name,
      link,
      notes,
      bought: false,
      boughtAt: null,
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

// Only these fields ever leave the server.
function publicItem(item) {
  return {
    id: item.id,
    name: item.name,
    link: item.link,
    notes: item.notes,
    bought: item.bought,
    boughtAt: item.boughtAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

module.exports = { Store, publicItem };
