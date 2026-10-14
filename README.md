# Harvey-Malige Baby Registry

One shared wishlist, maintained by the owners and shared with family and friends by a link.

- **Owners** sign in with a passcode to add, edit, and delete items.
- **Guests** open the link, see the list, and tick items they've bought. No account, no name.
- Everyone sees changes automatically (the page checks every 10 seconds).
- Items can need more than one (e.g. "need 3"). Guests tick off one at a time.
- A guest can undo their own tick from the same browser. Owners can undo any tick.

Plan and roadmap: [docs/PLAN.md](docs/PLAN.md)

## Run it locally

Requires Node.js 22 or newer. No dependencies to install.

```sh
OWNER_PASSCODE="a passcode of 8+ characters" npm start
```

Open the share link printed in the terminal, for example `http://localhost:3000/l/<token>`. Then tap **Owner sign in** at the bottom of the page.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OWNER_PASSCODE` | yes | — | Passcode for owner sign-in. Minimum 8 characters. |
| `SUPABASE_URL` | for Vercel | — | Supabase project URL. When set, the list is stored in Supabase instead of a file. |
| `SUPABASE_ANON_KEY` | with `SUPABASE_URL` | — | Supabase public anon key. Access still needs `REGISTRY_SECRET`. |
| `REGISTRY_SECRET` | with `SUPABASE_URL` | — | Random key the server sends to Supabase. Stored only as a hash in the database. Keep it secret. |
| `LIST_TITLE` | no | `Harvey-Malige Baby Registry` | Heading shown on the list. |
| `PORT` | no | `3000` | HTTP port (local server only). |
| `DATA_FILE` | no | `data/registry.json` | Where the list is saved when `SUPABASE_URL` is not set. |
| `PUBLIC_URL` | no | `http://localhost:PORT` | Base URL printed in the share link. Use `https://…` in production, which also turns on secure cookies. |
| `TRUST_PROXY` | no | `false` | Set to `true` behind a reverse proxy or host. Rate limits then read the client address from `X-Forwarded-For`. Without it, every guest looks like the proxy and shares one limit. |

The share token is generated the first time the registry is created and stored with the list. Keep the data safe: losing it creates a new list with a new link.

## Where the list is stored

- **A file** (default): fine for running on your own computer or a host with a persistent disk. Used by the Docker setup below.
- **Supabase Postgres**: used on Vercel, where functions do not keep files between requests. Set up with [supabase/schema.sql](supabase/schema.sql). Saves are compare-and-swap, so two servers cannot overwrite each other's changes. Without `REGISTRY_SECRET` the table reads as empty, so the public anon key alone reveals nothing.

## Deploy to Vercel

The app is a static page in `public/` plus one serverless function in `api/`. `vercel.json` routes the links, and a daily cron calls `/api/health` so the free Supabase project does not pause from inactivity.

1. Create a Supabase project. In its SQL editor, run `supabase/schema.sql` after replacing the placeholder hash with the SHA-256 of your registry key.
2. Create a Vercel project from this repository (or deploy the files directly).
3. In Vercel, add these environment variables (mark the passcode and keys as **Sensitive**):
   - `OWNER_PASSCODE`
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `REGISTRY_SECRET`
4. Deploy. The share link is `https://<your-project>.vercel.app/l/<token>`. The token is created on first run. Sign in and use **Copy share link** to get the full link.

Vercel sets `VERCEL=1`, which turns on secure cookies and proxy-aware rate limits automatically.

The page sends every API call to `/api/route?p=<path>`. On this Vercel project only single-segment `/api` paths reach the function (`/api/lists/<token>` returned Vercel's 404), so keep that shape if you change the routing.

## Deploy with Docker

```sh
docker build -t baby-registry .
docker run -p 3000:3000 \
  -e OWNER_PASSCODE="a passcode of 8+ characters" \
  -e PUBLIC_URL="https://your-domain.example" \
  -e TRUST_PROXY=true \
  -v registry-data:/data \
  baby-registry
```

The `/data` volume must persist. Without it, the list is lost when the container is replaced. Any host that runs containers and offers a persistent disk will work (Render, Fly.io, Railway, or a small VPS).

## How ticks and undo work

- Each browser gets a random device id in `localStorage`. The server stores only a SHA-256 hash of it, never the id, and never a name.
- Ticking adds a claim to the item. An item is bought when claims reach its quantity.
- A guest can undo only the latest claim their browser made. Owners can undo the latest claim of any browser.
- Clearing site data loses the ability to undo from that browser. Owners can still untick.

## Sign-in

- Owner sessions are signed cookies, valid for 30 days. They work on any server instance, with nothing stored on the server.
- Signing out clears the cookie in that browser only.
- Changing `OWNER_PASSCODE` signs out every browser at once.

## Rate limits

- Owner sign-in: 10 attempts per 15 minutes per IP. Then `429` with `Retry-After`.
- Ticks and undos: 60 per minute per IP.
- Counters live in memory. On Vercel each warm instance keeps its own count, so the limit is a soft one. With a 20+ character passcode, sign-in guessing is not a practical risk.

## Tests

```sh
npm test
```

Runs the API tests against real servers with temporary data files, and the storage tests (including a fake Supabase server for the save-and-retry logic). Covers sign-in, quantities, undo, rate limits, and migration from the Sprint 1 data format.

## Project layout

```
api/[...path].js   Vercel function: every /api request
src/server.js      builds the request handler from environment variables
src/index.js       local entry point: starts an HTTP server
src/app.js         routes, owner sessions, input validation, security headers
src/store.js       registry: file and Supabase storage with safe updates
public/            the page: index.html, app.js (vanilla JS), styles.css
supabase/schema.sql one-time database setup
vercel.json        routes, static output, daily cron
test/              API and storage tests (node:test)
docs/PLAN.md       product plan, user stories, sprint log
```

## Security notes

- The share link is the only way to read the list. The token is 24 random bytes.
- Owner sessions are `HttpOnly`, `SameSite=Strict`, and signed with the passcode, so they cannot be forged without it.
- Every write must be sent as JSON, which blocks cross-site form posts.
- Links must be `http` or `https`.
- The page sends `Referrer-Policy: no-referrer`, so the share token does not leak to shop links.
- Guest ticks store no name or identity. Each browser's device id is hashed before it is stored.
- The Supabase table has row-level security on. Reads and writes need the `x-registry-key` header, and only a hash of the key is stored in the database.
- Ticks and sign-in attempts are rate limited per IP.
