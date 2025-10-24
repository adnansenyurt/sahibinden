# AI guidance for this repo

This project is a Chrome Extension (Manifest V3) plus a local Express server to sync notes for sahibinden.com search results.

Big picture
- Extension UI/logic lives in `extension/` and runs only on `*.sahibinden.com` (see `manifest.json`).
- Content script `extension/contentScript.js` augments the search results table (table id "searchResultsTable"; rows with class "searchResultsItem"):
  - On row hover, shows a floating note box positioned next to the thumbnail, with inline styles only.
  - Notes are stored locally under `localStorage` keys `sahi:note:<adId>`; a small gold star is overlaid when a non-empty note exists.
  - A fixed "Sync notes" button appears bottom-right; the popup can also trigger sync.
- Popup (`popup.html`/`popup.js`) lets users save an API token to `chrome.storage.local` key `sahi:jwt` and send a `SAHI_SYNC_NOTES` message to the page.
- Server in `server/server.js` exposes CORS-enabled endpoints on `http://localhost:3000`, keeps notes in-memory, and logs requests/responses.

Data and control flow
- Ad id detection (`getAdId`) checks (in order): `data-id`/`dataset.id`, element `id` numeric part, then hrefs containing `/ilan/` or `/detay/` to extract a number.
- Notes sync (`doSyncNotes` in content script):
  - Collect all `localStorage` keys with prefix `sahi:note:` and POST each to `POST /api/notes/:adId` with JSON `{ note }` and header `Authorization: Bearer <token>`.
  - Token is read from `chrome.storage.local['sahi:jwt']` with `localStorage` fallback; prompt if missing.
  - The content script also listens for `chrome.runtime.onMessage` with `{ type: 'SAHI_SYNC_NOTES' }` from the popup.
- Server auth is a placeholder: only checks a non-empty Bearer token; replace `authMiddleware` to validate JWT if needed. Stored notes are kept in-memory (`Map`).

Developer workflow
- Server: `cd server && npm i && npm run dev` (nodemon on :3000). Endpoints: `/`, `/.well-known/appspecific/com.chrome.devtools.json`, `/api/health`, `POST /api/notes/:adId`, `GET /api/notes`.
- Extension: Chrome → Extensions → Developer mode → Load unpacked → select `extension/`. Visit a sahibinden results page with the search table present.
- Token: open the extension popup, paste any token (non-empty for now). It is saved as `sahi:jwt`.
- Sync: either click the popup "Sync notes" or the in-page floating "Sync notes" button.
- Debug: the server logs [REQ]/[RES] with headers (Authorization redacted). The content script guards against double-inject via `window['sahi-hover-logger']` and logs errors to console.

Conventions and patterns
- Storage keys: `sahi:note:<adId>` for notes, `sahi:jwt` for token. Keep this prefix when adding features.
- DOM selectors and layout are brittle to site changes: primary target is the tbody rows with class "searchResultsItem" under the table with id "searchResultsTable". Update `ROW_SEL` and `getAdId` together if sahibinden markup changes.
- Styling for injected UI is inline JS (no external CSS) to avoid style bleed. The star overlay is a simple absolutely-positioned div appended to the first cell.
- Message contract: `SAHI_SYNC_NOTES` responds with `{ ok: boolean, count?: number }`.
- Network base: `SERVER_BASE` is hard-coded to `http://localhost:3000`; update both the content script and extension permissions if you change it.

Files to look at first
- `extension/manifest.json`, `extension/contentScript.js`, `extension/popup.js`
- `server/server.js`, `server/package.json`
- Legacy stubs (not used): `extension/content.js`, `extension/injected.js`, `extension/styles.scss/css`

When extending
- Add new server routes in `server/server.js` and wire matching fetches in the content script; keep CORS and auth behavior aligned.
- If persisting notes, replace the in-memory `Map` with a real store and adjust return shapes minimally (client expects success boolean and echoes of data).
- Keep UI self-contained and avoid global CSS; use inline styles and z-index `2147483647` for overlays.
