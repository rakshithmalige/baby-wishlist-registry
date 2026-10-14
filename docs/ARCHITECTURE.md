# Architecture

How the Baby Registry is put together: the browser page, the server function, the database, and why each part is connected the way it is.

## The short version

The app is a small web page plus one server function. The page is plain HTML, CSS and JavaScript. Every action the page takes goes to the server function, which checks the request, changes the list, and saves it to a database. The database holds the whole list as one JSON document. Vercel runs the page and the function. Supabase stores the list.

## The pieces

| Piece | Files | What it does |
|---|---|---|
| Page | `public/index.html`, `public/app.js`, `public/styles.css` | What you see. Draws the list, sends taps to the server, redraws when the server answers. |
| Entry point | `api/[...path].js` | Vercel's door into the server code. Starts the server once per instance, then passes each request in. |
| Server setup | `src/server.js` | Reads environment variables, picks the storage, builds the request handler. |
| Rules and routes | `src/app.js` | Routes each request, checks passwords, validates input, applies the rules (one tick per gift, holds, undo, backup). |
| Data layer | `src/store.js` | Loads and saves the list, and keeps saves safe when several servers write at once. Decides what data leaves the server. |
| Database | `supabase/schema.sql` | One table, `registry`, with one row holding the whole list. Row-level rules block anyone without the registry key. |
| Hosting config | `vercel.json` | Which folder is the website, the `/l/…` link rewrite, and the daily cron. |
| Local and Docker | `src/index.js`, `Dockerfile` | Run the same server on a laptop or in a container, storing the list in a file. |
| Tests | `test/` | Tests that run the server, plus storage tests against a fake Supabase. |

## Diagram 1: the whole system

```
 Guest or owner's browser                    Vercel
┌───────────────────────────┐        ┌──────────────────────────────────┐
│ index.html + styles.css   │ 1 page │ Static files (public/)           │
│ app.js  (the screen)      │ ◄───── │  index.html, app.js, css, icons  │
│                           │        │                                  │
│ localStorage              │ 2 API  │ Function  api/[...path].js       │
│  · device id              │ ─────► │   └─ src/server.js  (set up)     │
│  · first name (optional)  │ /api/  │       └─ src/app.js  (rules)     │
└───────────────────────────┘ route?p│           └─ src/store.js (data) │
                                     └────────────────┬─────────────────┘
                                                      │ REST + JSON
                                                      ▼
                                     ┌──────────────────────────────────┐
                                     │ Supabase (Postgres)              │
                                     │ table registry: 1 row = the list │
                                     └──────────────────────────────────┘

 Vercel cron (daily, 12:00 UTC) ──► GET /api/health ──► function ──► Supabase
                                    (a read, so the free database never pauses)
```

## Diagram 2: what happens when a guest ticks a gift

```
Guest taps the box on "Travel cot"
 │
 ▼
app.js   claim(item)
 │  POST /api/route?p=lists/<token>/items/<id>/bought
 │  header X-Device-Id: <random id from this browser>
 │  body   {"name": "Aunt Sue"}           (name is optional)
 ▼
app.js (server)  handle()
 │  1. rewrite ?p=… into /api/lists/…/bought
 │  2. rate limit: 60 per minute per IP
 │  3. hash the device id (the raw id is never stored)
 ▼
store.js  update(change)
 │  a. read the row from Supabase: the list and its revision number
 │  b. check the share token, find the gift, drop expired holds
 │  c. already full?  → 409 "already bought"
 │     otherwise add a claim { by: hash, name, at }
 │  d. save only if the revision is still the one read
 │        ├─ saved      → done
 │        └─ changed    → someone else saved first: reload and retry (max 5)
 ▼
Response: the item, without device ids or claim lists
 │
 ▼
app.js   "Thank you!" notice, then refresh() → GET list → draw the screen
```

## Diagram 3: owner sign-in

```
passcode ──► POST /api/route?p=owner/login
                │  compare with OWNER_PASSCODE (constant-time)
                ▼
             Set-Cookie: owner_session = <expiry>.<HMAC(passcode, expiry)>

Later requests send the cookie. The server recomputes the HMAC with the
passcode and checks the expiry. No session is stored on the server, so any
server instance can check it.
```

## Diagram 4: a gift hold

```
Guest taps "Reserve for 2 days"
 │  POST …/items/<id>/hold   (device id header)
 ▼
store.js  update
 │  drop expired holds
 │  free = quantity − bought − active holds
 │  free > 0?  → add hold { by: hash, expiresAt: now + 48 h }
 ▼
Other guests see "Reserved by someone · until …" (no name)
The holder sees "Reserved for you" with Release, and ticking the gift
turns the hold into a bought claim. After 48 hours the hold stops counting.
```

## Where the rules live

- **Who can do what:** `src/app.js`. Owners need a valid signed cookie. Guests need the share token in the URL. Ticks and holds need a device id.
- **What counts as bought:** a claim without an expiry. Holds have an expiry and don't count as bought.
- **What leaves the server:** `publicItem()` in `src/store.js`. It strips device hashes and claim lists. Owners also get `boughtBy` (names or "Anonymous").
- **Input checks:** `cleanItemInput()`, `cleanGiverName()`, and the link and quantity helpers in `src/app.js`.

## API routes

All page calls go through `/api/route?p=<path>` on Vercel. The local server also accepts the direct form.

| Method | Path (after `p=`) | Who | Purpose |
|---|---|---|---|
| GET | `health` | anyone | Reads the registry, so the daily cron keeps Supabase awake |
| GET | `manifest?start=/l/<token>` | anyone | Home-screen manifest for that list |
| GET | `lists/<token>` | anyone with the link | The list (add `&version=N` to skip unchanged data) |
| GET | `lists/<token>/backup` | owner | The whole list as a JSON download |
| POST | `owner/login` | anyone | Passcode → signed session cookie |
| POST | `owner/logout` | anyone | Clears this browser's cookie |
| POST | `lists/<token>/items` | owner | Add a gift |
| PATCH | `lists/<token>/items/<id>` | owner | Edit a gift |
| DELETE | `lists/<token>/items/<id>` | owner | Delete a gift |
| POST | `lists/<token>/items/<id>/bought` | anyone with the link | Tick a gift (optional name) |
| DELETE | `lists/<token>/items/<id>/bought` | the ticking browser, or owner | Undo the latest tick |
| POST | `lists/<token>/items/<id>/hold` | anyone with the link | Reserve one unit for 48 hours |
| DELETE | `lists/<token>/items/<id>/hold` | the holding browser, or owner | Release a hold |

## Why it's built this way

- **Static page plus one function.** The page is just files, so it loads quickly and is cheap to host. All the logic sits in one place.
- **Everything goes through `/api/route?p=…`.** This project's Vercel deployment only reached single-segment `/api` paths in testing. Multi-segment paths returned Vercel's 404, so the page sends every call through one segment and passes the real path in `p`.
- **One JSON document, not many tables.** A registry is a few hundred gifts at most, so one document is simpler to store and back up. The trade-off is that each save rewrites the whole list, which is fine at this size.
- **Revision check on every save.** Vercel can run several copies of the function at once. The revision check stops one copy from overwriting another's change.
- **Signed cookies for owners.** Serverless copies don't share memory, so sessions can't be kept in memory. A signed cookie works on any copy. Changing the passcode signs out every browser.
- **A hash of the device id.** This lets a browser undo its own tick and release its own hold, with no accounts. Names are stored only when a guest chooses to leave one.
- **Polling every 10 seconds.** Simple and works everywhere. The `?version=` check means an unchanged list costs almost nothing.
- **No npm packages.** The server uses only Node's built-in modules. Nothing to install or patch.
- **One code path for local and Vercel.** The same server code runs on a laptop or in Docker, with a file as storage, and on Vercel, with Supabase.
- **Locked database.** The table is protected by row-level rules. The public anon key alone shows nothing. The server must also send the registry key, which is stored only as a hash.

## Things to know

- **Rate limits are soft on Vercel.** Owner sign-in allows 10 attempts per 15 minutes per IP. Ticks, undos, holds and releases allow 60 per minute per IP. Each running copy of the function counts separately, so the limit is approximate.
- **Free Supabase pauses after a week idle.** The daily cron call prevents that as long as the site is deployed.
- **Pushing to git doesn't deploy.** Deploys are triggered from a commit. Until one is made, the live site keeps the old version.
- **Undo and holds are per browser.** Clearing site data removes the ability to undo or release from that browser. Owners can still do both.
- **Price is not built yet.** Owners would enter it on add and edit, as an optional field.
