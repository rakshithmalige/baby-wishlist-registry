# Baby Wishlist & Registry

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
| `LIST_TITLE` | no | `Baby Wishlist` | Heading shown on the list. |
| `PORT` | no | `3000` | HTTP port. |
| `DATA_FILE` | no | `data/registry.json` | Where the list is saved. |
| `PUBLIC_URL` | no | `http://localhost:PORT` | Base URL printed in the share link. Use `https://…` in production, which also turns on secure cookies. |
| `TRUST_PROXY` | no | `false` | Set to `true` when behind a reverse proxy or host (Render, Fly, Railway, nginx). Rate limits then read the client address from `X-Forwarded-For`. Without it, every guest looks like the proxy and shares one limit. |

The share token is generated the first time the app starts and saved in `DATA_FILE`. Keep that file: deleting it creates a new list with a new link.

## Deploy with Docker

```sh
docker build -t baby-wishlist .
docker run -p 3000:3000 \
  -e OWNER_PASSCODE="a passcode of 8+ characters" \
  -e PUBLIC_URL="https://your-domain.example" \
  -e TRUST_PROXY=true \
  -v wishlist-data:/data \
  baby-wishlist
```

The `/data` volume must persist. Without it, the list is lost when the container is replaced. Any host that runs containers and offers a persistent disk will work (Render, Fly.io, Railway, or a small VPS).

## How ticks and undo work

- Each browser gets a random device id in `localStorage`. The server stores only a SHA-256 hash of it, never the id, and never a name.
- Ticking adds a claim to the item. An item is bought when claims reach its quantity.
- A guest can undo only the latest claim their browser made. Owners can undo the latest claim of any browser.
- Clearing site data loses the ability to undo from that browser. Owners can still untick.

## Rate limits

- Owner sign-in: 10 attempts per 15 minutes per IP. Then `429` with `Retry-After`.
- Ticks and undos: 60 per minute per IP.
- Limits are in memory and reset when the server restarts.

## Tests

```sh
npm test
```

Runs the API tests in `test/` against real servers with temporary data files. Covers sign-in, quantities, undo, rate limits, and migration from the Sprint 1 data format.

## Project layout

```
src/index.js     entry point: reads configuration and starts the server
src/app.js       HTTP routes, owner sessions, input validation, security headers
src/store.js     the list: loads and saves registry.json atomically
public/          the page: index.html, app.js (vanilla JS), styles.css
test/            API tests (node:test)
docs/PLAN.md     product plan, user stories, sprint log
```

## Security notes

- The share link is the only way to read the list. Token is 24 random bytes.
- Owner sessions are random, stored in memory, `HttpOnly`, `SameSite=Strict`, and last 30 days. Restarting the server signs owners out.
- Every write must be sent as JSON, which blocks cross-site form posts.
- Links must be `http` or `https`.
- The page sends `Referrer-Policy: no-referrer`, so the share token does not leak to shop links.
- Guest ticks store no name or identity. Each browser's device id is hashed before it is stored.
- Ticks and sign-in attempts are rate limited per IP.
