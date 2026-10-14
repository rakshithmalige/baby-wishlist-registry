'use strict';

const path = require('node:path');
const { createApp } = require('./app');
const { Store } = require('./store');

const port = Number(process.env.PORT) || 3000;
const passcode = process.env.OWNER_PASSCODE || '';
const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'registry.json');
const title = process.env.LIST_TITLE || 'Baby Wishlist';
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');

if (passcode.length < 8) {
  console.error('Set OWNER_PASSCODE to at least 8 characters before starting.');
  process.exit(1);
}

const store = new Store(dataFile);
const server = createApp({
  store,
  passcode,
  title,
  cookieSecure: publicUrl.startsWith('https://'),
});

server.listen(port, () => {
  console.log(`${title} running on port ${port}`);
  console.log(`Share link: ${publicUrl}/l/${store.shareToken}`);
});
