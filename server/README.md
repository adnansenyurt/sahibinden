# Sahibinden Notes Server

A minimal Express server that accepts and stores public and private notes from the Chrome extension. It exposes a health endpoint, a bulk upsert endpoint for notes, and a simple GET to read the in-memory store.

This server is intended for local development. It keeps data in memory (cleared on restart). You can adapt it to persist notes to a database.

---

## Prerequisites
- Node.js 16+ (18+ recommended)
- npm (comes with Node.js)

Project layout:
```
server/
  server.js        # Express app (listens on port 3000)
  node_modules/    # Installed dependencies
  README.md        # This file
```

---

## Install & run
From the project root or the `server` folder:

```bash
cd server
npm install
node server.js
```

You should see:
```
Server running on http://localhost:3000
```

If you prefer auto-reload during development:
```bash
cd server
npm install --save-dev nodemon
npx nodemon server.js
```

(Optional) Add a script to `server/package.json`:
```json
{
  "scripts": {
    "dev": "nodemon server.js"
  }
}
```
Run with:
```bash
npm run dev
```

---

## Endpoints
Base URL: `http://localhost:3000`

All API endpoints (except `/` and `/api/health`) require a Bearer token header. The current implementation accepts any non-empty token and does not validate it yet.

Common header:
```
Authorization: Bearer <your-token>
```

### GET `/` (root)
Returns a simple text message confirming the server is running.

### GET `/api/health`
Health check.

Response example:
```json
{
  "status": "ok",
  "timestamp": "2025-11-03T12:34:56.789Z"
}
```

### POST `/api/notes/bulk`
Bulk upsert of notes for listings.

Request body:
```json
{
  "items": [
    { "id": "<listingId>", "note": "<publicNote>", "privNote": "<privateNote>", "updatedAt": "<optional ISO8601>" }
  ]
}
```

- `id` (string): Listing identifier. Required when `note` or `privNote` is provided.
- `note` (string): Public note. Optional; if present and non-empty, it will be stored as `kind: "normal"`.
- `privNote` (string): Private note. Optional; if present and non-empty, it will be stored as `kind: "private"`.
- `updatedAt` (string, ISO 8601): Optional; if absent, the server assigns current time.

Response example:
```json
{
  "success": true,
  "count": 2,
  "items": [
    { "success": true, "rowId": "123", "note": "Public note", "kind": "normal",  "updatedAt": "2025-11-03T...Z" },
    { "success": true, "rowId": "123", "note": "Private note", "kind": "private", "updatedAt": "2025-11-03T...Z" }
  ]
}
```

### POST `/api/notes/:adId`
Upsert a single note for one listing (public or private). Mostly used for testing.

Request body (example uses a public note):
```json
{ "rowId": "<listingId>", "note": "<text>", "kind": "normal" }
```

Notes:
- If `rowId` is omitted, it will be inferred from the `:adId` path parameter.
- `note` must be a non-empty string.
- `kind` may be either `"normal"` or `"private"` (defaults to `"normal"`).

### GET `/api/notes`
Returns all notes currently stored in memory (both public and private) in the order they were last upserted.

Response example:
```json
[
  { "rowId": "123", "note": "Public note",  "kind": "normal",  "updatedAt": "2025-11-03T...Z" },
  { "rowId": "123", "note": "Private note", "kind": "private", "updatedAt": "2025-11-03T...Z" }
]
```

---

## Example curl calls
Replace `testtoken` and listing IDs as needed.

Health check:
```bash
curl http://localhost:3000/api/health
```

Bulk upsert (public + private):
```bash
curl -X POST http://localhost:3000/api/notes/bulk \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer testtoken' \
  -d '{
        "items": [
          {"id": "123", "note": "Güney cephe", "privNote": "Kiracı zor"},
          {"id": "124", "privNote": "Fiyat pazarlıkla düşer"}
        ]
      }'
```

Read stored notes:
```bash
curl -H 'Authorization: Bearer testtoken' http://localhost:3000/api/notes
```

Single note upsert (public):
```bash
curl -X POST http://localhost:3000/api/notes/125 \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer testtoken' \
  -d '{"note": "Okul yakın", "kind": "normal"}'
```

---

## Behavior & implementation notes
- Port: `3000` (change inside `server.js` if needed).
- CORS: enabled for all origins via `app.use(cors())`.
- Auth: a minimal middleware checks for the presence of `Authorization: Bearer <token>`. JWT is not validated yet (placeholder for production).
- Storage: in-memory `Map` keyed by `${rowId}:normal` and `${rowId}:private`. Data is lost when the process restarts.
- Logging: Structured logging via Pino with log levels. Set LOG_LEVEL env var (e.g., debug, info, warn, error). HTTP requests are logged with pino-http and Authorization header is redacted.

---

## Troubleshooting
- EADDRINUSE: Port 3000 is busy. Stop the other service or change the port in `server.js`.
- 401 Unauthorized: Ensure you send `Authorization: Bearer <token>` and the token is non-empty.
- CORS errors in browser: CORS is already enabled. If you modified it, re-enable or configure allowed origins.
- Extension cannot sync: Verify the server is running, the popup has the token saved, and the host permission `http://localhost:3000/*` exists (it does in `chrome-ext/manifest.json`).

---

## Next steps (optional)
- Real JWT validation using your identity provider/public keys.
- Persist notes to a database or file storage instead of memory.
- Add environment variable for PORT (e.g., using `dotenv`).
- Add tests for the endpoints (e.g., Jest + supertest).
