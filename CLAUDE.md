# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Chrome Extension (Manifest V3) + Express server system for scraping and annotating property listings from sahibinden.com (Turkish real estate marketplace). The extension scrapes listing data, supports note-taking with sync to a local server, and integrates with Google Gemini AI for property summaries and OpenStreetMap for geographic analysis.

## Development Commands

### Server
```bash
cd server
npm install
npm run dev          # Run with nodemon (hot-reload)
npm start            # Run without hot-reload
```
Server runs on port 3000. Set `LOG_LEVEL` env var for logging verbosity.

### Chrome Extension
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `chrome-extension/` directory
4. After changing service worker code, click "Reload" on the extension

### Testing (Manual)
No automated test framework. Verify server endpoints with curl:
```bash
# Health check
curl http://localhost:3000/api/health

# Bulk upsert notes
curl -X POST http://localhost:3000/api/notes/bulk \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer testtoken' \
  -d '{"items":[{"id":"123","note":"Public note","privNote":"Private note"}]}'

# Read notes
curl -H 'Authorization: Bearer testtoken' http://localhost:3000/api/notes
```

## Architecture

### Component Communication
```
Chrome Extension                          Express Server
┌─────────────────────────────────────┐   ┌──────────────────────┐
│ popup.js ←→ background.js (SW)      │──▶│ server.js            │
│     ↓           ↓                   │   │  - In-memory Map     │
│ chrome.storage  DOM scraping        │   │  - Bearer auth       │
│     ↓           ↓                   │   │  - Pino logging      │
│ geminiClient.js  opennesAPI.js      │   └──────────────────────┘
│ (Gemini AI)      (Overpass/OSM)     │
└─────────────────────────────────────┘
```

### Extension Files
- `background.js` - Service worker: page scraping orchestration, note persistence, API calls
- `popup.js` / `popup.html` - UI for login, notes, API key config
- `geminiClient.js` - Google Generative AI integration for property summaries
- `opennesAPI.js` - OpenStreetMap/Overpass API for geographic surroundings analysis
- `notes_content.js` - Content script for in-page note overlay on search results

### Server
- Single file Express app with in-memory `Map` storage (keyed by `${rowId}:normal` and `${rowId}:private`)
- Auth middleware requires non-empty Bearer token (no JWT validation)
- CORS enabled for all origins

### Storage Keys
- `sahi:note:<adId>` - Notes in Chrome local storage
- `sahi:jwt` - Auth token
- `sahi:emlakUrl` - Emlak API base URL (default: `http://localhost:8080`)

### Ad ID Detection
`getAdId` function checks in order: `data-id`/`dataset.id`, element `id` numeric part, then hrefs containing `/ilan/` or `/detay/`.

## Key Conventions

- Turkish field names in templates/placeholders are intentional; preserve exact casing and dotted/undotted `ı` variants (both `{{Notlarım}}` and `{{Notlarim}}`)
- Inline styles only for injected UI (no external CSS) to avoid style bleed
- Use z-index `2147483647` for overlays
- Message contract: `SAHI_SYNC_NOTES` responds with `{ ok: boolean, count?: number }`
- Prefer async/await for async flows

## Working with Saved HTML Files

For `file://` URLs, enable "Allow access to file URLs" in extension settings:
- Detail pages: Extension scrapes directly from DOM without re-fetching
- Listing pages: Scrapes only available fields (title, price, location, image, id, URL); does NOT fetch detail pages in background

## Common Issues

- **Port 3000 busy**: Stop other process or change `PORT` in `server.js` and update `manifest.json` host permission
- **401 Unauthorized**: Ensure `Authorization: Bearer <token>` header with non-empty token
- **Extension not updating**: Reload extension in chrome://extensions; refresh page for content script changes