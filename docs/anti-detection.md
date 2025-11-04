Anti-detection strategies for Sahibinden Scraper

Goal: reduce the likelihood that sahibinden.com (or upstream CDNs) detect the extension’s automated activity. The measures below are split into design, manifest, network, DOM injection, and operator practices. Items marked [implemented] are minimally added in this change set; others are recommendations you can adopt as needed.

1) Extension design and operator practices
- Prefer user-initiated actions: Start scraping only from the popup button and process the current page/tab. Avoid auto-run on tab updates or on extension install.
- Pace your actions: Add random delays and avoid bursts. Humans don’t request dozens of detail pages per second. [implemented: background stealth delay helper; default OFF]
- Constrain concurrency: Process one listing at a time, or use a very small pool. If you add parallel detail fetches, cap to 2–3.
- Backoff on errors: If you see HTTP 429/403/5xx, exponentially back off and pause all work for a few minutes.
- Work within typical session patterns: Navigate via the UI, scroll, and let content load normally. Avoid headless-like behaviors (rapid URL fetches without viewport interaction).
- Avoid 24/7 usage: Mix active periods and breaks; do not run scraping for hours nonstop.

2) Manifest and permissions
- Keep host_permissions minimal: Only include domains you truly need. Currently: sahibinden.com, shbdn.com (CDN), Google Maps, Overpass, Gemini, localhost. Remove any experimental hosts before release.
- Use declarativeNetRequest (DNR) sparingly: Only block non-essential telemetry/analytics if you are sure it won’t break the site. Prefer per-resource rules over wide domain blocks.
- Do not request broad extension permissions you don’t use (e.g., unnecessary tabs or scripting permissions). Periodically audit manifest.json.

3) Network behavior
- Randomized pacing: Add small random sleep before non-critical fetches to avoid machine-like timing. [implemented: maybeStealthDelay() in background]
- Limit or batch external calls: Cache template files, avoid repeatedly downloading the same assets.
- Respect robots.txt and TOS: If the site’s terms disallow automated scraping, reconsider usage and keep to low volume.
- Identify and avoid anti-bot markers: Sudden spikes to APIs, repeated identical headers, or missing typical browser headers can be a signal. Prefer using the page DOM (already done here) rather than programmatic background fetches to the target domain.
- Timeouts and retries: Use timeouts and attempt limited retries with jitter on transient failures. Consider pausing the whole job on repeated 429 responses.

4) Content script and DOM injection
- Minimize DOM footprint: Keep injected nodes small, stable, and styled to avoid layout shifts; prefer absolute-positioned overlays with pointer-events: none when not interactive. This project already keeps UI lightweight.
- Avoid polluting global scope: Wrap content script in an IIFE (already done), avoid adding globals that pages can detect.
- Avoid frequent mutations: Debounce observers and re-renders; excessive DOM changes can look automated. Prefer event-driven updates.
- Don’t override native events globally: Keep listeners scoped to your UI where possible; if you must intercept keys, do so with capture=true but narrowly.

5) URL calls and request hygiene
- Don’t fetch listing pages via background fetch: Read the open tab DOM instead (current approach). Background fetches to the same origin are easier to pattern-match.
- Add jitter before cross-origin utility calls (maps, template fetch, local API). [implemented: jitter on proxyFetchJSON, template fetch, and POST to local emlak]
- Cap repeated calls to the same endpoint (e.g., Gemini) and add caching if possible.

6) Suggested optional changes (safe defaults)
- Stealth mode flag: Use chrome.storage.local { 'sahi:stealth': true, 'sahi:stealthMinMs': 400, 'sahi:stealthMaxMs': 1400 } to enable pacing. Defaults remain OFF so normal dev is unaffected. [implemented]
- DNR telemetry filtering: Consider adding rules for clearly non-essential beacons (e.g., pixel.gif, analytics.js) on shbdn/sahibinden if you verify no breakage. Keep rules disabled by default and enable via extension options in the future.
- Concurrency limiter: If you add parallel detail fetching later, implement a simple queue with max=2–3 and random gaps between tasks.

7) What we changed in code (minimal and safe)
- background.js: added maybeStealthDelay() helper that consults chrome.storage.local flag and inserts a short random sleep. Wired it into:
  - proxyFetchJSON (used for cross-origin fetch proxy)
  - Emlak JSON POST (local development server)
  - DOCX template fetch
- Default remains unchanged (stealth disabled) so behavior is identical unless you opt in.

8) How to enable stealth mode
- Open DevTools Console for the service worker (chrome://extensions → your extension → Service Worker → Inspect).
- Run:
  chrome.storage.local.set({ 'sahi:stealth': true, 'sahi:stealthMinMs': 400, 'sahi:stealthMaxMs': 1400 })
- You can adjust min/max delays; keep them small to avoid long jobs. Example: 250–1200 ms.
- To disable:
  chrome.storage.local.remove(['sahi:stealth','sahi:stealthMinMs','sahi:stealthMaxMs'])

9) Additional concrete recommendations for this project
- Manifest cleanup: When moving to production, remove localhost:8080 host permission if unused, and keep localhost:3000 only if the notes server is active.
- Token handling: Store only a generic presence token for the notes server (current behavior), do not forward site cookies.
- Template caching: On first fetch of sahibinden_template.docx, cache its ArrayBuffer in session storage and reuse it to avoid repeated network hits.
- Gentle UI observers: MutationObserver usage should be bounded; consider disconnecting and reconnecting on larger intervals to reduce DOM churn.
- Human-like triggers: If you later automate paging, require a click per page and wait for random intervals, including occasional longer waits.

Disclaimer: These measures decrease risk; they don’t guarantee immunity. Always comply with the target site’s terms and legal guidance before scraping.
