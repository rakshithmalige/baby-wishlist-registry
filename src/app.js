'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { newItem, publicItem, confirmedClaims, activeHolds, pruneHolds, CATEGORIES, HOLD_MS } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_COOKIE = 'owner_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_QUANTITY = 20;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

const DEFAULT_LIMITS = {
  loginAttempts: { max: 10, windowMs: 15 * 60 * 1000 },
  ticks: { max: 60, windowMs: 60 * 1000 },
};

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
  '/icon-512.png': { file: 'icon-512.png', type: 'image/png' },
  '/apple-touch-icon.png': { file: 'apple-touch-icon.png', type: 'image/png' },
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
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.expose = true;
    Object.assign(this, extra);
  }
}

// Fixed-window counter per key (IP address). Old windows are pruned as we go.
// Counters live in this process, so on serverless hosts each warm instance
// keeps its own count. That is a soft limit, not a strict one.
function createRateLimiter({ max, windowMs }) {
  const windows = new Map(); // key -> { count, resetAt }
  return (key) => {
    const now = Date.now();
    if (windows.size > 10000) {
      for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    }
    let entry = windows.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(key, entry);
    }
    entry.count += 1;
    if (entry.count <= max) return { ok: true };
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  };
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Returns a request listener: (req, res) => void. Works with http.createServer
// locally and with a Vercel Node function.
function createApp({
  store,
  passcode,
  title = 'Harvey-Malige Baby Registry',
  cookieSecure = false,
  trustProxy = false,
  limits = {},
}) {
  const limitLogin = createRateLimiter({ ...DEFAULT_LIMITS.loginAttempts, ...limits.loginAttempts });
  const limitTicks = createRateLimiter({ ...DEFAULT_LIMITS.ticks, ...limits.ticks });

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
    return crypto.timingSafeEqual(Buffer.from(sha256Hex(String(a))), Buffer.from(sha256Hex(String(b))));
  }

  function clientIp(req) {
    if (trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function enforce(limiter, req) {
    const result = limiter(clientIp(req));
    if (!result.ok) {
      throw new HttpError(429, 'Too many requests. Please wait a moment and try again.', {
        retryAfter: result.retryAfter,
      });
    }
  }

  function checkToken(state, token) {
    if (!safeEqual(token, state.list.shareToken)) throw new HttpError(404, 'This list link is not valid');
  }

  function itemOrThrow(state, id) {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) throw new HttpError(404, 'Item not found');
    return item;
  }

  // Owner sessions are signed cookies, not server-side records, so they work
  // on any instance. The signing key is the passcode itself: changing the
  // passcode signs out every browser.
  function signSession(expiresAt) {
    return crypto.createHmac('sha256', passcode).update(`owner-session:${expiresAt}`).digest('base64url');
  }

  function cookieValue(req, name) {
    const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_.-]+)`));
    return match ? match[1] : null;
  }

  function isOwner(req) {
    const value = cookieValue(req, SESSION_COOKIE);
    if (!value) return false;
    const [expires, mac] = value.split('.');
    const expiresAt = Number(expires);
    return Number.isFinite(expiresAt) && expiresAt > Date.now() && Boolean(mac) && safeEqual(mac, signSession(expiresAt));
  }

  function requireOwner(req) {
    if (!isOwner(req)) throw new HttpError(401, 'Owner sign-in required');
  }

  // Returns a hash of the browser's device id, or null if none was sent.
  // The raw id never leaves the browser and is never stored.
  function deviceHashFrom(req) {
    const id = req.headers['x-device-id'];
    return typeof id === 'string' && DEVICE_ID_PATTERN.test(id) ? sha256Hex(id) : null;
  }

  function requireDevice(req) {
    const device = deviceHashFrom(req);
    if (!device) throw new HttpError(400, 'Missing device id');
    return device;
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

  function cleanQuantity(value) {
    if (value === undefined || value === null || value === '') return 1;
    const n = typeof value === 'string' ? Number(value) : value;
    if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) {
      throw new HttpError(400, `Quantity must be a whole number from 1 to ${MAX_QUANTITY}`);
    }
    return n;
  }

  function cleanCategory(value) {
    if (value === undefined || value === null || value === '') return 'Other';
    if (!CATEGORIES.includes(value)) throw new HttpError(400, `Category must be one of: ${CATEGORIES.join(', ')}`);
    return value;
  }

  function cleanPriority(value) {
    if (value === undefined || value === null) return false;
    if (typeof value !== 'boolean') throw new HttpError(400, 'Most wanted must be true or false');
    return value;
  }

  // The optional first name a guest can leave on a tick. Blank means anonymous.
  function cleanGiverName(value) {
    return cleanText(value, 40, 'Your name') || null;
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
    if (!partial || 'quantity' in input) fields.quantity = cleanQuantity(input.quantity);
    if (!partial || 'category' in input) fields.category = cleanCategory(input.category);
    if (!partial || 'priority' in input) fields.priority = cleanPriority(input.priority);
    return fields;
  }

  async function readJson(req) {
    // Some hosts parse the body before we see it. Use that if it is there.
    if (req.body && typeof req.body === 'object') return req.body;
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

  function snapshot(state, device, owner) {
    const now = Date.now();
    return {
      version: state.version,
      updatedAt: state.updatedAt,
      items: state.items.map((item) => publicItem(item, device, { owner, now })),
    };
  }

  // ---- handlers: each returns { status?, body, headers? } -------------------

  async function getList({ req, params, url }) {
    const state = await store.read();
    checkToken(state, params[0]);
    const owner = isOwner(req);
    const device = deviceHashFrom(req);
    const version = url.searchParams.get('version');
    if (version !== null && Number(version) === state.version) {
      return { body: { version: state.version, unchanged: true, owner } };
    }
    return { body: { title, ...snapshot(state, device, owner), owner } };
  }

  function login({ req, body }) {
    enforce(limitLogin, req);
    const supplied = typeof body.passcode === 'string' ? body.passcode : '';
    if (!safeEqual(supplied, passcode)) throw new HttpError(401, 'Wrong passcode');

    const expiresAt = Date.now() + SESSION_TTL_MS;
    return {
      body: { ok: true },
      headers: { 'Set-Cookie': sessionCookie(`${expiresAt}.${signSession(expiresAt)}`, SESSION_TTL_MS / 1000) },
    };
  }

  // Clears this browser's cookie. Other browsers keep their sessions until
  // they expire or the passcode changes.
  function logout() {
    return { body: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
  }

  async function addItem({ req, params, body }) {
    requireOwner(req);
    const fields = cleanItemInput(body);
    const item = await store.update((state) => {
      checkToken(state, params[0]);
      const created = newItem(fields);
      state.items.push(created);
      return created;
    });
    return { status: 201, body: { item: publicItem(item, deviceHashFrom(req), { owner: true }) } };
  }

  async function editItem({ req, params, body }) {
    requireOwner(req);
    const item = await store.update((state) => {
      checkToken(state, params[0]);
      const target = itemOrThrow(state, params[1]);
      const fields = cleanItemInput(body, { partial: true });
      if (Object.keys(fields).length === 0) throw new HttpError(400, 'Nothing to change');
      const bought = confirmedClaims(target).length;
      if (fields.quantity !== undefined && fields.quantity < bought) {
        throw new HttpError(400, `Quantity cannot be lower than the ${bought} already bought`);
      }
      Object.assign(target, fields, { updatedAt: new Date().toISOString() });
      return target;
    });
    return { body: { item: publicItem(item, deviceHashFrom(req), { owner: true }) } };
  }

  async function deleteItem({ req, params }) {
    requireOwner(req);
    await store.update((state) => {
      checkToken(state, params[0]);
      const target = itemOrThrow(state, params[1]);
      state.items = state.items.filter((item) => item.id !== target.id);
    });
    return { body: { ok: true } };
  }

  // Anyone with the link can tick an item (guests and owners alike). If this
  // browser is holding the item, the tick turns the hold into a bought claim.
  async function markBought({ req, params, body }) {
    enforce(limitTicks, req);
    const device = requireDevice(req);
    const giver = cleanGiverName(body.name);
    const item = await store.update((state) => {
      checkToken(state, params[0]);
      const target = itemOrThrow(state, params[1]);
      pruneHolds(target);
      const bought = confirmedClaims(target).length;
      if (bought >= target.quantity) {
        const message =
          target.quantity === 1 ? 'Someone already marked this one as bought' : 'All of these have already been bought';
        throw new HttpError(409, message, { item: publicItem(target, device) });
      }
      const now = new Date().toISOString();
      const ownHold = target.claims.find((claim) => claim.expiresAt && claim.by === device);
      if (ownHold) target.claims = target.claims.filter((claim) => claim !== ownHold);
      target.claims.push({ id: crypto.randomUUID(), by: device, at: now, name: giver });
      target.updatedAt = now;
      return target;
    });
    return { body: { item: publicItem(item, device) } };
  }

  // Owners can undo the latest bought claim on an item. Guests can undo only
  // the latest claim made from their own browser.
  async function unmarkBought({ req, params }) {
    enforce(limitTicks, req);
    const owner = isOwner(req);
    const device = deviceHashFrom(req);
    const item = await store.update((state) => {
      checkToken(state, params[0]);
      const target = itemOrThrow(state, params[1]);
      const bought = confirmedClaims(target);
      const undoable = owner ? bought : bought.filter((claim) => device && claim.by === device);
      if (undoable.length === 0) {
        if (owner) throw new HttpError(409, 'Nothing to undo on this item');
        throw new HttpError(403, 'Only the browser that ticked this can undo it');
      }
      const latest = undoable[undoable.length - 1];
      target.claims = target.claims.filter((claim) => claim.id !== latest.id);
      target.updatedAt = new Date().toISOString();
      return target;
    });
    return { body: { item: publicItem(item, device) } };
  }

  // Reserve one unit for this browser for 48 hours. Holds count against what
  // is still free, so two people cannot both hold the last one.
  async function holdItem({ req, params }) {
    enforce(limitTicks, req);
    const device = requireDevice(req);
    const item = await store.update((state) => {
      checkToken(state, params[0]);
      const target = itemOrThrow(state, params[1]);
      const now = Date.now();
      pruneHolds(target, now);
      const bought = confirmedClaims(target).length;
      if (bought >= target.quantity) {
        const message =
          target.quantity === 1 ? 'Someone already marked this one as bought' : 'All of these have already been bought';
        throw new HttpError(409, message, { item: publicItem(target, device) });
      }
      if (target.claims.some((claim) => claim.expiresAt && claim.by === device)) {
        throw new HttpError(409, 'You already have this reserved', { item: publicItem(target, device) });
      }
      const free = target.quantity - bought - activeHolds(target, now).length;
      if (free <= 0) {
        throw new HttpError(409, 'All of these are reserved right now. Please try again later.', {
          item: publicItem(target, device),
        });
      }
      const at = new Date(now).toISOString();
      target.claims.push({ id: crypto.randomUUID(), by: device, at, expiresAt: new Date(now + HOLD_MS).toISOString() });
      target.updatedAt = at;
      return target;
    });
    return { body: { item: publicItem(item, device) } };
  }

  // A browser can release its own hold. An owner can release any hold.
  async function releaseHold({ req, params }) {
    enforce(limitTicks, req);
    const owner = isOwner(req);
    const device = deviceHashFrom(req);
    const item = await store.update((state) => {
      checkToken(state, params[0]);
      const target = itemOrThrow(state, params[1]);
      const holds = activeHolds(target).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
      // Your own hold first; an owner with no hold of their own releases the soonest one.
      const victim = holds.find((hold) => device && hold.by === device) || (owner ? holds[0] : null);
      if (!victim) {
        if (owner) throw new HttpError(409, 'Nothing is reserved on this item');
        throw new HttpError(403, 'Only the browser that reserved this can release it');
      }
      target.claims = target.claims.filter((claim) => claim.id !== victim.id);
      target.updatedAt = new Date().toISOString();
      return target;
    });
    return { body: { item: publicItem(item, device) } };
  }

  // Owners only: the whole list as a JSON file, for keeping a copy.
  async function backup({ req, params }) {
    requireOwner(req);
    const state = await store.read();
    checkToken(state, params[0]);
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      body: state,
      headers: { 'Content-Disposition': `attachment; filename="baby-registry-backup-${stamp}.json"` },
    };
  }

  // The web app manifest for a list page, so "Add to Home Screen" opens that
  // list. The start address is only accepted in the list-page form.
  function manifest({ url }) {
    const start = url.searchParams.get('start') || '';
    return {
      body: {
        name: title,
        short_name: 'Baby Registry',
        start_url: LIST_PAGE.test(start) ? start : '/',
        scope: '/',
        display: 'standalone',
        background_color: '#fff8f3',
        theme_color: '#b8476a',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' },
    };
  }

  // Reads the registry, so a daily ping keeps a free-tier database from pausing.
  async function health() {
    await store.read();
    return { body: { ok: true } };
  }

  const ROUTES = [
    ['GET', /^\/api\/health$/, health],
    ['GET', /^\/api\/manifest$/, manifest],
    ['GET', /^\/api\/lists\/([^/]+)$/, getList],
    ['GET', /^\/api\/lists\/([^/]+)\/backup$/, backup],
    ['POST', /^\/api\/owner\/login$/, login],
    ['POST', /^\/api\/owner\/logout$/, logout],
    ['POST', /^\/api\/lists\/([^/]+)\/items$/, addItem],
    ['PATCH', /^\/api\/lists\/([^/]+)\/items\/([^/]+)$/, editItem],
    ['DELETE', /^\/api\/lists\/([^/]+)\/items\/([^/]+)$/, deleteItem],
    ['POST', /^\/api\/lists\/([^/]+)\/items\/([^/]+)\/bought$/, markBought],
    ['DELETE', /^\/api\/lists\/([^/]+)\/items\/([^/]+)\/bought$/, unmarkBought],
    ['POST', /^\/api\/lists\/([^/]+)\/items\/([^/]+)\/hold$/, holdItem],
    ['DELETE', /^\/api\/lists\/([^/]+)\/items\/([^/]+)\/hold$/, releaseHold],
  ];

  // ---- request dispatch --------------------------------------------------

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // The page sends every API call to /api/route?p=<path>. This project's
    // Vercel deployment only reaches single-segment /api paths, so the real
    // path travels in ?p=.
    const pathname =
      url.pathname === '/api/route' && url.searchParams.has('p') ? `/api/${url.searchParams.get('p')}` : url.pathname;

    if (req.method === 'GET' && (STATIC_FILES[pathname] || LIST_PAGE.test(pathname))) {
      return sendPage(res, pathname);
    }

    for (const [method, pattern, handler] of ROUTES) {
      const match = pathname.match(pattern);
      if (!match || method !== req.method) continue;

      if (req.method !== 'GET') {
        // Browsers cannot send this content type cross-site without a CORS preflight,
        // which we never allow. That is our CSRF guard for the guest tick endpoint.
        if (!(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new HttpError(415, 'Requests must be sent as JSON');
        }
      }
      const body = req.method === 'GET' ? {} : await readJson(req);
      const result = await handler({ req, params: match.slice(1), url, body });
      return sendJson(res, result.status || 200, result.body, result.headers);
    }

    throw new HttpError(404, 'Not found');
  }

  return (req, res) => {
    handle(req, res).catch((err) => {
      if (err.expose) {
        const { item, retryAfter } = err;
        const headers = retryAfter ? { 'Retry-After': String(retryAfter) } : {};
        return sendJson(res, err.status, { error: err.message, ...(item && { item }) }, headers);
      }
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong' });
    });
  };
}

module.exports = { createApp };
