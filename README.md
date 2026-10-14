# Baby Wishlist & Registry

One shared wishlist, maintained by the owners and shared with family and friends by a link.

- **Owners** sign in with a passcode to add, edit, and delete items.
- **Guests** open the link, see the list, and tick items they've bought. No account, no name.
- Everyone sees changes automatically (the page checks every 10 seconds).

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

The share token is generated the first time the app starts and saved in `DATA_FILE`. Keep that file: deleting it creates a new list with a new link.

## Deploy with Docker

```sh
docker build -t baby-wishlist .
docker run -p 3000:3000 \
  -e OWNER_PASSCODE="a passcode of 8+ characters" \
  -e PUBLIC_URL="https://your-domain.example" \
  -v wishlist-data:/data \
  baby-wishlist
```

The `/data` volume must persist. Without it, the list is lost when the container is replaced. Any host that runs containers and offers a persistent disk will work (Render, Fly.io, Railway, or a small VPS).

## Tests

```sh
npm test
```

Runs the API tests in `test/` against a real server with a temporary data file.

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
- Guest ticks store no name or identity.
