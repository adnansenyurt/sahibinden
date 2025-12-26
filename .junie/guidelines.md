# Project Guidelines (Sahibinden Scraper + Notes Server)

This document captures project-specific knowledge to help future development and debugging. It focuses on the Chrome extension in `chrome-extension/` and the local notes server in `server/`.

---

## 1) Build / Configuration Instructions

### Chrome Extension (Manifest V3)
- Location: `chrome-extension/`
- Background: `background.js` (service worker)
- Content script: `notes_content.js`
- Popup: `popup.html`
- Manifest permissions are already configured for:
  - Host permissions: `https://*.sahibinden.com/*`, `https://*.shbdn.com/*`, Google Maps, Overpass, Gemini API, `http://localhost:3000/*`, `http://localhost:8080/*`, and `file://*/*`.
  - Extension permissions: scripting, activeTab, downloads, notifications, storage, declarativeNetRequest, offscreen, tabs.

Build/Load steps:
1. No bundling step is required; code runs as-is.
2. Open Chrome → Extensions → Enable Developer Mode.
3. Load unpacked → select the `chrome-extension/` directory.
4. If you change background/service worker code, click “Reload” the extension and reopen the DevTools for the service worker to see new logs.
5. Icons are SVG in `chrome-extension/icons`. If you need PNGs, see `chrome-extension/README.txt` for dimensions.

Runtime configuration (extension):
- Notes sync host must be reachable at `http://localhost:3000/` (already allowed by manifest).
- The popup UI stores an auth token in Chrome storage; server only checks presence (not validity yet). Use any non-empty token for local dev.
- Emlak API integration: popup allows configuring base URL (stored at `sahi:emlakUrl` in chrome.storage.local, default `http://localhost:8080`). JWT for API calls is stored under `sahi:jwt`; POSTs go to `/api/custom/properties/import` with fallback to `/api/properties/import`.

### Local Notes Server (Express)
- Location: `server/`
- Entry: `server.js`
- Port: `3000` (hardcoded). If busy, stop the other process or change the constant in `server.js`.
- Storage: in-memory `Map` keyed by `${rowId}:normal` and `${rowId}:private`. Data is volatile.
- CORS: enabled for all origins.
- Auth: middleware requires `Authorization: Bearer <token>`, non-empty. No JWT validation yet.

Install & run:
- From project root or `server/`:
  - `cd server`
  - `npm install`
  - `node server.js`
- Expected log: `Server running on http://localhost:3000`

---

## 2) Testing Information

### How to run tests (manual, via curl)
This project does not yet include an automated test harness. The server endpoints are easily verifiable with curl.

Precondition: ensure the server is running on port 3000.

- Health check:
  - `curl http://localhost:3000/api/health`
  - Expected JSON: `{ "status": "ok", "timestamp": "<ISO>" }`

- Bulk upsert (public + private):
  - `curl -X POST http://localhost:3000/api/notes/bulk \`
    `  -H 'Content-Type: application/json' \`
    `  -H 'Authorization: Bearer testtoken' \`
    `  -d '{"items":[{"id":"123","note":"Public note","privNote":"Private note"}]}'`
  - Expected: `{ "success": true, "count": 2, "items": [ ...normal..., ...private... ] }`

- Read stored notes:
  - `curl -H 'Authorization: Bearer testtoken' http://localhost:3000/api/notes`
  - Expected: array with two entries for `rowId: "123"` with kinds `normal` and `private`.

These concrete calls were executed successfully during guideline preparation.

### Adding new tests
- Preferred stack (future): Jest + supertest for endpoint tests under `server/`.
  - Example outline:
    - `npm i -D jest supertest`
    - Export the Express `app` from `server.js` (refactor to not call `listen` inside module) and create `server/app.js` with `module.exports = app;`.
    - Write tests under `server/__tests__/notes.test.js` invoking endpoints with supertest.
    - Run with `npx jest`.
- For the extension, integration tests are best done manually in a dev profile due to MV3 service worker lifecycle. If automated browser tests are needed later, consider Playwright with `--headed` and proper service worker activation handling.

### Create and run a simple test (demonstration)
- Already performed (commands above). To recreate:
  1) Start server: `node server/server.js`
  2) Run health: `curl http://localhost:3000/api/health`
  3) Upsert notes: `curl -X POST http://localhost:3000/api/notes/bulk -H 'Content-Type: application/json' -H 'Authorization: Bearer testtoken' -d '{"items":[{"id":"123","note":"Public note","privNote":"Private note"}]}'`
  4) Read notes: `curl -H 'Authorization: Bearer testtoken' http://localhost:3000/api/notes`
- Expected outputs match the examples under “How to run tests”.

---

## 3) Additional Development Information

### Extension specifics
- Background service worker does scraping orchestration, and note persistence/sync. See `background.js` for how fields are mapped; notes are injected under both `{{Notlarım}}` and `{{Notlarim}}` placeholders to handle dotted ı.
- Network permissions include localhost for talking to the notes server; ensure the port matches `manifest.json` if you change the server port.
- Storage:
  - Public notes are stored in Chrome local storage under keys like `sahi:note:<rowId>` (legacy sync storage also checked for backward compatibility).
  - Private notes use a separate key space when synced to the server (`kind: "private"`).

### Server specifics
- Request/response logger prints sanitized headers and payloads for GET/POST, helping debugging.
- Error handling returns JSON `{ error: message }` with HTTP 400/401/500 where appropriate.
- Bulk endpoint logic stores up to two entries per `id` (normal/private) with independent timestamps.

### Code style & conventions
- JavaScript (Node 16+ / MV3-compatible).
- Prefer async/await for async flows; avoid mixing with raw callbacks unless required by Chrome APIs.
- Turkish field names in templates/placeholders are intentional; preserve exact casing and the dotted/undotted `ı` variants as implemented.

### Common pitfalls
- Port 3000 already in use → stop the other process or edit `PORT` in `server/server.js`, and update `manifest.json` host permission accordingly.
- Missing Authorization header → server returns 401 for API endpoints (except `/` and `/api/health`). The extension popup must capture and store the token.
- Chrome service worker changes require extension reload; content script changes require page refresh.

### Future improvements
- Extract server `app` for testability; add Jest + supertest.
- Real JWT validation and persistence (DB).
- Configurable server URL in extension options.
- Structured logging (pino) with log levels.


---
