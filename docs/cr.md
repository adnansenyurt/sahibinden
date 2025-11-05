## Pending features

+ Show date/time of the note when note edit box is displayed.
+ Login and receive the JWT token from Emlak app from popup.html. (Implemented basic login in popup to AUTH_URL)
+ Generate a JSON object/array for scraped data and post single-detail to server. (Implemented mapping and POST in background.js)
- Merge note data and scrapped data on server.
+ Add minimum scrapping for listing page (list page now only scrapes visible fields and returns immediately; detail pages are processed in background with human-like delays and per-item Emlak POST)
- Adopt scrapper to scrap listing from a saved html
+ Emlak: extend table to import all fields.
+ Emlak: Build custom property detail view with image.
- Emlak: set Managing agency and managing agent from imported data.
- Emlak: add notes table and link to Property to import notes

### JSON schema (proposed for Emlak import)

Property object fields (English):
- id: string — the listing ID scraped from ID/İlan No or inferred from URL. Used to relate notes.
- url: string — canonical listing URL.
- title: string — listing title.
- description: string — free-text description from detail page.
- locationText: string — raw location line like "İstanbul / Kadıköy / Rasimpaşa Mh.".
- city: string — parsed city.
- district: string — parsed district.
- neighborhood: string — parsed neighborhood or remaining parts.
- mapUrl: string — Google Maps URL built from page coordinates when available.
- parcelUrl: string — TKGM Parsel URL when coordinates are present.
- latitude: number|null — decimal latitude extracted from mapUrl (if present).
- longitude: number|null — decimal longitude extracted from mapUrl (if present).
- priceText: string — raw price text as seen on page.
- price: number|null — numeric price parsed from priceText (best-effort).
- contactName: string — agent/owner name from page.
- contactPhone: string — agent/office phone.
- listingFrom: string — "Kimden" field (owner/real estate office etc.).
- frontageText: string — "Cephe" value(s) as text.
- opennessText: string — Çevre openness summary lines.
- frontageOpennessText: string — openness limited to selected frontage directions.
- nearestTransportText: string — lines describing nearest metro/bus etc.
- summary: string — AI-generated summary mapped from existing flow (if enabled), otherwise empty.
- image: object|null — the first/main image:
  - base64: string — data URL (image/*;base64,...) for embedding.
  - width: number — natural width.
  - height: number — natural height.
- notes: array — per-listing notes collected locally:
  - Each item: { type: "public"|"private", text: string, updatedAt: ISO string }
- original: object — the raw scraped row as produced by scraper (Turkish keys), for traceability.
- scrapedAt: ISO string — generation timestamp.

Posting rule:
- Bulk (listing page): background generates an array of property objects and stores it under chrome.storage.session key 'sahi:lastJsonPayload' (for future download/inspection). No POST is performed.
- Single (detail page): when the result contains exactly one row, background maps to a single property object and POSTs it to {BASE}/api/custom/properties/import with Authorization: Bearer <jwt>. Body payload per API example is the entire JSON object serialized to a JSON string (i.e., quoted string in JSON envelope).

Configuration:
- Token storage key: chrome.storage.local['sahi:jwt'] (already added by popup login).
- Optional base URL override: chrome.storage.local['sahi:emlakUrl'] (defaults to http://localhost:8080).