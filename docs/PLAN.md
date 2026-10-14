# Baby Wishlist & Registry: Product Plan

## 1. Goal

One shared wishlist for the baby, maintained by Maia and me, shared with family and friends by a link. Guests tick off gifts they have bought. Everyone sees the latest state without asking.

## 2. Users

| Role | Who | Can do |
|---|---|---|
| Owner | Maia and me | Sign in with a shared passcode. Add, edit, delete items. Untick items. Copy the share link. |
| Guest | Anyone with the link | View the list. Tick an item as bought. No account, no name, nothing stored about them. |

## 3. Scope and user stories

### Sprint 1: MVP (covers the four requirements)

| ID | Story | Acceptance criteria |
|---|---|---|
| US-1 | As an owner, I sign in with a passcode so only we can change the list. | Wrong passcode is rejected. Owner-only endpoints return 401 without a session. Session lasts 30 days in that browser. |
| US-2 | As an owner, I add an item with a name and optional link and notes. | Name is required (max 120 chars). Link must be http or https; a missing scheme is added. Item shows on every open page within 10 seconds. |
| US-3 | As an owner, I edit an item. | Changes are saved and visible to everyone. |
| US-4 | As an owner, I delete an item. | Delete asks for confirmation. Item disappears for everyone. |
| US-5 | As a guest, I open the share link and see the full list. | Works without sign-in on a phone. Wrong or unknown token returns "link not valid". |
| US-6 | As a guest, I tick an item as bought without giving my name. | No identity is stored or shown. Ticked items move to the bottom and show "Bought". |
| US-7 | As a guest, I cannot tick an item that is already ticked. | A second tick gets a clear "already bought" message and the page refreshes. |
| US-8 | As an owner, I can untick an item (mistake or returned gift). | Only owners can untick. Guests cannot untick. |
| US-9 | Everyone sees updates without reloading. | Page checks for changes every 10 seconds (paused when the tab is hidden) and on focus. Shows the time of the last change. |

### Sprint 2: Improve

| ID | Story | Acceptance criteria |
|---|---|---|
| US-10 | As a guest, I can undo my own tick from the same browser. | A random device token is kept in the browser. Only that device can undo its tick. Other guests cannot. Stored hashed. Owners can still untick. |
| US-11 | As an owner, I can set how many of an item we need (e.g. "need 3"). | Quantity 1 to 20. Guests tick one at a time ("2 of 3 bought"). Item is fully bought at the quantity. Existing data migrates to quantity 1. |
| US-12 | The server resists abuse. | Passcode attempts and guest ticks are rate-limited per IP. Limit responses return 429. |

### Backlog (not scheduled)

- Per-person owner accounts (instead of one shared passcode)
- Live push updates (SSE) instead of polling
- Prices and a running total
- Categories and sorting ("most wanted" first)
- Thank-you tracker (needs a decision: it conflicts with anonymous ticks)
- Email when something is bought
- Printable view
- Deployment automation

## 4. Non-functional requirements

- **Mobile first.** Works at 375px width. 16px side gutter. No horizontal scroll. Tap targets at least 44px.
- **Safe rendering.** User text is never written as HTML. Links use `rel="noopener noreferrer"`.
- **Private link.** The share token is 24 random bytes. The page sends `Referrer-Policy: no-referrer`, so the token does not leak to shop links when guests click through.
- **Privacy.** Guest ticks store no name or identity. Only a hashed device token is kept (Sprint 2).
- **Durability.** Data survives restarts. Writes are atomic (temp file, then rename).
- **Simple to run.** No build step. No npm dependencies. Runs with Node 22 or Docker.

## 5. Architecture

```
Browser (vanilla JS, polls every 10s)
   │  HTTPS
Node 22 server (node:http, zero dependencies)
   ├─ static files: index.html, app.js, styles.css
   ├─ JSON API under /api
   └─ data/registry.json (atomic writes, persistent volume in Docker)
```

Why this shape: one list for two owners and dozens of guests does not need a database server. A single JSON file is easy to back up, and the whole app is one process to deploy.

### Data model (`registry.json`)

```json
{
  "version": 7,
  "updatedAt": "2026-10-14T12:00:00.000Z",
  "list": { "shareToken": "…", "createdAt": "…" },
  "items": [
    {
      "id": "uuid",
      "name": "Muslin swaddles (4-pack)",
      "link": "https://example.com/swaddles",
      "notes": "Grey or white",
      "bought": false,
      "boughtAt": null,
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

Sprint 2 replaces `bought` / `boughtAt` with `quantity` and `claims` (see section 7).

### API

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/l/:token` | anyone | Serves the list page |
| GET | `/api/lists/:token` | anyone | Full list. Add `?version=N` to get `{ unchanged: true }` when nothing changed |
| POST | `/api/owner/login` | anyone | `{ passcode }` sets the session cookie |
| POST | `/api/owner/logout` | owner | Ends the session |
| POST | `/api/lists/:token/items` | owner | Add item |
| PATCH | `/api/lists/:token/items/:id` | owner | Edit item |
| DELETE | `/api/lists/:token/items/:id` | owner | Delete item |
| POST | `/api/lists/:token/items/:id/bought` | anyone | Tick as bought (409 if already ticked) |
| DELETE | `/api/lists/:token/items/:id/bought` | owner (S1); owner or own device (S2) | Untick |

Every non-GET request must send `Content-Type: application/json`. This blocks cross-site form posts.

## 6. Sprint 1: Build the MVP

**Sprint goal:** Maia and I can build the list, share the link, and guests can tick items that everyone sees update.

**Definition of Done**
- Acceptance criteria for US-1 to US-9 are met
- `npm test` passes, covering each story's API behaviour
- Checked at 375px width in a browser
- No user text is rendered as HTML
- README explains setup, configuration and deployment
- Committed to the feature branch

## 7. Sprint 2: Improve

**Sprint goal:** Mistakes are easy to fix, and registries that need several of an item work.

- **Data migration.** On load, `bought: true` becomes `quantity: 1` with one claim. `bought: false` becomes `quantity: 1` with no claims. Covered by a test.
- **Claims model.** `claims: [{ id, deviceHash | null, at }]`. `bought = claims.length >= quantity`. Owner claims have `deviceHash: null`.
- **Undo.** Guest DELETE removes the latest claim with their device hash, if they have one. Owners remove the latest claim of any kind.
- **Rate limits.** Fixed window per IP, in memory. Login: 10 attempts per 15 minutes. Ticks: 60 per minute.

## 8. Open questions for the owners

1. **Where to host?** The app is Docker-ready and needs a persistent volume for `/data`. Options: Render, Fly.io, Railway, or a small VPS. I have not deployed anything.
2. **List title.** Default is "Baby Wishlist". Do you want the baby's name in it?
3. **Passcode.** Set `OWNER_PASSCODE` when deploying. Use something only the two of you know.
4. **Guest undo.** Plan says guests can undo only their own tick, from the same browser. Confirm this is what you want.

## 9. Sprint log

_Filled in at the end of each sprint: what shipped, what changed, what to fix next._

- **Sprint 1 (done):** Shipped US-1 to US-9. 16 API tests pass. Browser check at 375px: sign-in, add/edit/delete, guest tick, 409 on a double tick, owner untick, updates reaching other open pages within the 10-second poll, no horizontal scroll. Review: nothing blocking. Retro: the next most likely ask is "I ticked the wrong one", so undo comes first in Sprint 2.
- **Sprint 2:** _pending_
