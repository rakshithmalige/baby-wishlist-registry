'use strict';

const path = require('node:path');
const { createApp } = require('./app');
const { Registry, FileBackend, SupabaseBackend } = require('./store');

// Builds the request listener from environment variables. Used by the local
// server (src/index.js) and by the Vercel function (api/[...path].js).
async function createServer(env = process.env) {
  const passcode = env.OWNER_PASSCODE || '';
  if (passcode.length < 8) throw new Error('Set OWNER_PASSCODE to at least 8 characters before starting.');

  const backend = env.SUPABASE_URL
    ? new SupabaseBackend({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY || '' })
    : new FileBackend(env.DATA_FILE || path.join(__dirname, '..', 'data', 'registry.json'));

  const store = new Registry(backend);
  await store.init();

  const listener = createApp({
    store,
    passcode,
    title: env.LIST_TITLE || 'Baby Registry',
    // VERCEL is set on Vercel, where every request is HTTPS and behind its proxy.
    cookieSecure: Boolean(env.VERCEL) || (env.PUBLIC_URL || '').startsWith('https://'),
    trustProxy: Boolean(env.VERCEL) || env.TRUST_PROXY === 'true',
  });
  return { listener, store };
}

module.exports = { createServer };
