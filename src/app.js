'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { publicItem } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_COOKIE = 'owner_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};
const LIST_PAGE = /^\/l\/[A-Za-z0-9_-]+\/?$/;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createApp({ store, passcode, title = 'Baby Wishlist', cookieSecure = false }) {
  const sessions = new Map(); // session id -> expiry timestamp

  // ---- helpers -----------------------------------------------------------

  function sendJson(res, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  }

  function sendPage(res, pathname) {
    const asset = LIST_PAGE.test(pathname) ? STATIC_FILES['/'] : STATIC_FILES[pathname];
    const body = fs.readFileSync(path.join(PUBLIC_DIR, asset.file));
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-cache',
      'Content-Type': asset.type,
      'Content-Length': body.length,
    });
    res.end(body);
  }

  // Constant-time comparison of two strings of any length.
  function safeEqual(a, b) {
    const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
    return crypto.timingSafeEqual(digest(a), digest(b));
  }

  function requireList(token) {
    if (!safeEqual(token, store.shareToken)) throw new HttpError(404, 'This list link is not valid');
  }

  function isOwner(req) {
    const match = (req.headers.cookie || '').match(/(?:^|;\s*)owner_session=([A-Za-z0-9_-]+)/);
    const expiresAt = match && sessions.get(match[1]);
    if (expiresAt && expiresAt > Date.now()) return true;
    if (match) sessions.delete(match[1]);
    return false;
  }

  function requireOwner(req) {
    if (!isOwner(req)) throw new HttpError(401, 'Owner sign-in required');
  }

  function findItem(id) {
    const item = store.findItem(id);
    if (!item) throw new HttpError(404, 'Item not found');
    return item;
  }

  function sessionCookie(value, maxAgeSeconds) {
    return (
      `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}` +
      (cookieSecure ? '; Secure' : '')
    );
  }

  function cleanText(value, max, label) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new HttpError(400, `${label} must be text`);
    const text = value.trim();
    if (text.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer`);
    return text;
  }

  function cleanLink(value) {
    let link = cleanText(value, 2000, 'Link');
    if (!link) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(link)) link = `https://${link}`;
    let url;
    try {
      url = new URL(link);
    } catch {
      throw new HttpError(400, 'Link must be a web address, like https://example.com');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new HttpError(400, 'Link must start with http:// or https://');
    }
    return url.href;
  }

  // Full item input for create; only the fields present for partial (edit).
  function cleanItemInput(input, { partial = false } = {}) {
    const fields = {};
    if (!partial || 'name' in input) {
      const name = cleanText(input.name, 120, 'Name');
      if (!name) throw new HttpError(400, 'Name is required');
      fields.name = name;
    }
    if (!partial || 'link' in input) fields.link = cleanLink(input.link);
    if (!partial || 'notes' in input) fields.notes = cleanText(input.notes, 500, 'Notes');
    return fields;
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large');
      chunks.push(chunk);
    }
    if (size === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed;
    } catch {
      throw new HttpError(400, 'Request body must be a JSON object');
    }
  }

  // ---- handlers: each returns { status?, body, headers? } -------------------

  function getList({ req, params, url }) {
    requireList(params[0]);
    const owner = isOwner(req);
    const version = url.searchParams.get('version');
    if (version !== null && Number(version) === store.state.version) {
      return { body: { version: store.state.version, unchanged: true, owner } };
    }
    return { body: { title, ...store.snapshot(), owner } };
  }

  function login({ body }) {
    const supplied = typeof body.passcode === 'string' ? body.passcode : '';
    if (!safeEqual(supplied, passcode)) throw new HttpError(401, 'Wrong passcode');

    const now = Date.now();
    for (const [id, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(id);

    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, now + SESSION_TTL_MS);
    return {
      body: { ok: true },
      headers: { 'Set-Cookie': sessionCookie(id, SESSION_TTL_MS / 1000) },
    };
  }

  function logout({ req }) {
    const match = (req.headers.cookie || '').match(/(?:^|;\s*)owner_session=([A-Za-z0-9_-]+)/);
    if (match) sessions.delete(match[1]);
    return { body: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
  }

  function addItem({ req, params, body }) {
    requireList(params[0]);
    requireOwner(req);
    const item = store.addItem(cleanItemInput(body));
    return { status: 201, body: { item: publicItem(item) } };
  }

  function editItem({ req, params, body }) {
    requireList(params[0]);
    requireOwner(req);
    const item = findItem(params[1]);
    const fields = cleanItemInput(body, { partial: true });
    if (Object.keys(fields).length === 0) throw new HttpError(400, 'Nothing to change');
    store.updateItem(item, fields);
    return { body: { item: publicItem(item) } };
  }

  function deleteItem({ req, params }) {
    requireList(params[0]);
    requireOwner(req);
    store.deleteItem(findItem(params[1]));
    return { body: { ok: true } };
  }

  function markBought({ params }) {
    requireList(params[0]);
    const item = findItem(params[1]);
    if (item.bought) {
      throw Object.assign(new HttpError(409, 'Someone already marked this one as bought'), {
        item: publicItem(item),
      });
    }
    store.updateItem(item, { bought: true, boughtAt: new Date().toISOString() });
    return { body: { item: publicItem(item) } };
  }

  function unmarkBought({ req, params }) {
    requireList(params[0]);
    requireOwner(req);
    const item = findItem(params[1]);
    store.updateItem(item, { bought: false, boughtAt: null });
    return { body: { item: publicItem(item) } };
  }

  const ROUTES = [
    ['GET', /^\/api\/lists\/([^/]+)$/, getList],
    ['POST', /^\/api\/owner\/login$/, login],
    ['POST', /^\/api\/owner\/logout$/, logout],
    ['POST', /^\/api\/lists\/([^/]+)\/items$/, addItem],
    ['PATCH', /^\/api\/lists\/([^/]+)\/items\/([^/]+)$/, editItem],
    ['DELETE', /^\/api\/lists\/([^/]+)\/items\/([^/]+)$/, deleteItem],
    ['POST', /^\/api\/lists\/([^/]+)\/items\/([^/]+)\/bought$/, markBought],
    ['DELETE', /^\/api\/lists\/([^/]+)\/items\/([^/]+)\/bought$/, unmarkBought],
  ];

  // ---- request dispatch --------------------------------------------------

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (STATIC_FILES[url.pathname] || LIST_PAGE.test(url.pathname))) {
      return sendPage(res, url.pathname);
    }

    for (const [method, pattern, handler] of ROUTES) {
      const match = url.pathname.match(pattern);
      if (!match || method !== req.method) continue;

      if (req.method !== 'GET') {
        // Browsers cannot send this content type cross-site without a CORS preflight,
        // which we never allow. That is our CSRF guard for the guest tick endpoint.
        if (!(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new HttpError(415, 'Requests must be sent as JSON');
        }
      }
      const body = req.method === 'GET' ? {} : await readJson(req);
      const result = handler({ req, params: match.slice(1), url, body });
      return sendJson(res, result.status || 200, result.body, result.headers);
    }

    throw new HttpError(404, 'Not found');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) {
        const { item } = err;
        return sendJson(res, err.status, { error: err.message, ...(item && { item }) });
      }
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong' });
    });
  });
}

module.exports = { createApp };
