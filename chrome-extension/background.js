// Lightweight background service worker for detail page scraping only
// Load helper modules (MV3 service worker supports importScripts)
try { importScripts('emlakConfig.js'); } catch (_) {}
try { importScripts('geminiClient.js'); } catch (_) {}
try { importScripts('opennesAPI.js'); } catch (_) {}

const DEFAULT_EMLAK_BASE_URL = (self.EMLAK_CONFIG?.DEFAULT_EMLAK_BASE_URL) || 'http://localhost:8084';
const RESOLVE_EMLAK_BASE_URL = self.EMLAK_CONFIG?.resolveEmlakBaseUrl || ((v) => (v || DEFAULT_EMLAK_BASE_URL).replace(/\/$/, ''));

// Scrape essential fields by executing a function in the page context
async function scrapeDetailInPage(tabId, url) {
  if (!tabId) return { error: 'No tabId provided' };
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const out = {
            URL: location.href,
            'İlan Başlığı': '',
            'Fiyat': '',
            'Açıklama': '',
            'Agent Adı': 'N/A',
            'Agent Telefon': 'N/A',
            'Harita': null,
            'Parsel': null
          };

          // Title: strictly read from <div class="classifiedDetailTitle"><h1>
          try {
            const titleEl = document.querySelector('.classifiedDetailTitle h1');
            out['İlan Başlığı'] = titleEl ? titleEl.textContent.trim() : '';
          } catch {}

          // Info list key-value
          try {
            document.querySelectorAll('ul.classifiedInfoList li').forEach((item) => {
              const label = item.querySelector('strong')?.innerText?.trim();
              const value = item.querySelector('span')?.innerText?.trim();
              if (label && typeof value !== 'undefined') out[label] = value;
            });
          } catch {}

          // Price
          try {
            const priceEl = document.querySelector('.classifiedInfo .classified-price-wrapper, .classified-price-wrapper, .classifiedInfo .price');
            const hidden = document.getElementById('favoriteClassifiedPrice');
            const priceText = priceEl?.textContent?.trim() || hidden?.value?.trim() || '';
            if (priceText) out['Fiyat'] = priceText;
          } catch {}

          // Description
          try {
            const descEl = document.querySelector('#classifiedDescription, .classifiedDescription, .description');
            const txt = descEl ? descEl.textContent.trim() : '';
            out['Açıklama'] = txt;
          } catch {}

          // Agent name/phone
          try {
            const nameEl = document.querySelector('.userName, .classifiedUserName, .user-info .name');
            const phoneEl = document.querySelector('.phone, .pretty-phone-part, a.phone');
            if (nameEl) out['Agent Adı'] = nameEl.textContent.trim();
            if (phoneEl) out['Agent Telefon'] = phoneEl.textContent.trim();
          } catch {}

          // Images: ONLY collect from .classifiedDetailMainPhoto label_images_* picture img
          try {
            const urls = [];

            const pushUrl = (u) => {
              if (!u) return;
              let v = String(u).trim();
              if (!v) return;
              // Normalize AVIF to JPG (Word often does not support AVIF)
              v = v.replace(/\.avif(\?.*)?$/i, '.jpg$1');
              try { v = new URL(v, location.href).toString(); } catch {}
              if (!urls.includes(v)) urls.push(v);
            };

            const pushSrcset = (srcset) => {
              if (!srcset) return;
              String(srcset).split(',').forEach(part => {
                const url = part.trim().split(' ')[0].trim();
                if (url) pushUrl(url);
              });
            };

            const main = document.querySelector('.classifiedDetailMainPhoto');
            if (main) {
              main.querySelectorAll('[id^="label_images_"] picture img').forEach(img => {
                // Prefer data-src first (real image), then src (may be a blank placeholder), then srcset
                let src = img?.getAttribute('data-src') || img?.getAttribute('src') || '';
                pushUrl(src);
                // pushSrcset(img.getAttribute('srcset'));
                // const dataSrcset = img.getAttribute('data-srcset');
                // if (dataSrcset) pushSrcset(dataSrcset);
              });
            }

            if (urls.length) out.scrapedImageUrls = urls;
          } catch {}

          // Map (lat/lon on #gmap)
          try {
            const gmap = document.getElementById('gmap');
            const lat = gmap?.getAttribute('data-lat');
            const lon = gmap?.getAttribute('data-lon');
            if (lat && lon) {
              out['Harita'] = `https://www.google.com/maps?q=${lat},${lon}`;
              out['Parsel'] = `https://parselsorgu.tkgm.gov.tr/#ara/cografi/${lat}/${lon}`;
            }
          } catch {}

          return { success: true, data: out };
        } catch (e) {
          return { error: String(e && e.message ? e.message : e) };
        }
      }
    });
    return result || { error: 'No result' };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

// --- Debug helper to emit API responses to popup for localhost:8084 (or configured base) ---
async function emitApiDebug({ method, url, resp, error, note, bodyLimit = 1000 }) {
  try {
    const { baseUrl } = await getAuthAndBase().catch(() => ({ baseUrl: '' }));
    const base = RESOLVE_EMLAK_BASE_URL(baseUrl);
    if (!url || !String(url).startsWith(base)) return; // only log calls to our API base
    const payload = { action: 'apiDebug', source: 'background', method: method || 'GET', url: String(url), note: note || '' };
    if (resp) {
      try {
        const clone = resp.clone();
        payload.status = resp.status;
        const ct = clone.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const j = await clone.json().catch(() => ({}));
          payload.body = JSON.stringify(j).slice(0, bodyLimit);
        } else {
          payload.body = (await clone.text().catch(() => '')).slice(0, bodyLimit);
        }
      } catch (_) {}
    }
    if (error) payload.error = String(error);
    try { chrome.runtime.sendMessage(payload); } catch (_) {}
  } catch (_) {}
}

// Optional enrichment using external systems (Overpass + Gemini)
async function enrichWithExternal(scraped) {
  try {
    const out = { ...scraped };

    // 1) Openness via Overpass if coordinates available
    try {
      const mapUrl = out['Harita'] || '';
      const { latitude, longitude } = parseCoordsFromMapUrl(mapUrl);
      if (typeof calculateOpenness === 'function' && latitude && longitude) {
        // Selected directions can be stored optionally; default to all
        const vals = await new Promise((res) => chrome.storage.local.get(['sahi:openDirs'], res));
        const dirs = Array.isArray(vals['sahi:openDirs']) ? vals['sahi:openDirs'] : undefined;
        const openness = await calculateOpenness(latitude, longitude, dirs);
        // Convert to human-readable strings similar to chrome-ext outputs
        try {
          const parts = [];
          for (const [dir, info] of Object.entries(openness || {})) {
            const status = info?.status || '';
            const reason = info?.reason ? ` (${info.reason})` : '';
            parts.push(`${dir}: ${status}${reason}`);
          }
          if (parts.length) {
            out['Çevre'] = parts.join(' | ');
            out['Cephe Çevre'] = out['Çevre'];
          }
        } catch (_) {}
      }
    } catch (_) {}

    // 2) Gemini summary if criteria and key exist
    try {
      const vals = await new Promise((res) => chrome.storage.local.get(['sahi:criteria', 'sahi:geminiKey'], res));
      const criteriaRaw = vals['sahi:criteria'];
      const apiKey = vals['sahi:geminiKey'];
      let criteria = [];
      if (Array.isArray(criteriaRaw)) criteria = criteriaRaw;
      else if (typeof criteriaRaw === 'string') criteria = criteriaRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (typeof generateSummaryWithGemini === 'function' && apiKey && criteria.length) {
        const summary = await generateSummaryWithGemini(criteria, out, apiKey).catch(() => '');
        if (summary) out['Özet'] = summary;
      }
    } catch (_) {}

    return out;
  } catch (_) {
    return scraped;
  }
}

// --- Simple in-memory caches for current page data and computed image diffs ---
const lastTabData = new Map(); // tabId -> { url, scraped, sourceId, ilanNo, scrapedImageUrls, newImageUrls }

function normalizeImageUrl(u) {
  try {
    if (!u) return '';
    let v = String(u).trim();
    v = v.replace(/\.avif(\?.*)?$/i, '.jpg$1');
    const url = new URL(v, 'https://dummy.invalid');
    // Strip query/hash when comparing; keep pathname
    return url.origin === 'null' ? v : (url.protocol + '//' + url.host + url.pathname);
  } catch (_) {
    return String(u || '').trim();
  }
}

async function getAuthAndBase() {
  const vals = await new Promise((res) => chrome.storage.local.get(['sahi:jwt', 'sahi:emlakUrl'], res));
  const jwt = vals['sahi:jwt'] || '';
  const baseUrl = RESOLVE_EMLAK_BASE_URL(vals['sahi:emlakUrl']);
  return { jwt, baseUrl };
}

async function fetchSyncDataForSource(sourceId) {
  if (!sourceId) return { ok: false, images: [], notes: [] };
  const { jwt, baseUrl } = await getAuthAndBase();
  // If there's no JWT, don't call the API at all to avoid 401 noise
  if (!jwt) {
    return { ok: true, images: [], notes: [] };
  }
  try {
    await ensureCorsBypassForBase(baseUrl);
  } catch {}
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const commonHeaders = {};
  if (jwt) commonHeaders['Authorization'] = `Bearer ${jwt}`;
  // help some servers pick a JSON-ish response
  commonHeaders['accept'] = commonHeaders['accept'] || '*/*';

  // Helper for GET requests with sourceId query param
  async function callGet(path) {
    try {
      const url = baseUrl + path + (path.includes('?') ? '&' : '?') + 'sourceId=' + encodeURIComponent(sourceId);
      const resp = await fetch(url, { method: 'GET', headers: commonHeaders, signal: controller.signal });
      // Emit debug info to popup for every call (success or failure)
      await emitApiDebug({ method: 'GET', url, resp });
      if (!resp.ok) {
        // For 401/403, still log but return empty to indicate no data
        if (resp.status === 401 || resp.status === 403) {
          return [];
        }
        try { console.error('[SAHI][sync] GET failed', { url, status: resp.status, statusText: resp.statusText }); } catch {}
        return null;
      }
      let json = null; try { json = await resp.json(); } catch { json = null; }
      return json;
    } catch (e) {
      try { console.error('[SAHI][sync] GET error', { path, error: (e && e.message) || String(e) }); } catch {}
      // Emit error info to popup
      try {
        const url = baseUrl + path + (path.includes('?') ? '&' : '?') + 'sourceId=' + encodeURIComponent(sourceId);
        await emitApiDebug({ method: 'GET', url, error: (e && e.message) || String(e) });
      } catch (_) {}
      return null;
    }
  }

  // 1) Fetch images list via dedicated endpoint
  let imagesResp = await callGet('/api/custom/property-import/sync-images');
  // 2) Fetch notes list via dedicated endpoint
  let notesResp = await callGet('/api/custom/property-import/sync-notes');


  clearTimeout(timeout);

  // Normalize images from various shapes
  let imageArr = [];
  const im = imagesResp;
  if (Array.isArray(im)) imageArr = im;
  else if (im && Array.isArray(im.imageSourceFiles)) imageArr = im.imageSourceFiles;
  else if (im && Array.isArray(im.images)) imageArr = im.images;
  else if (im && Array.isArray(im.imageUrls)) imageArr = im.imageUrls;
  imageArr = (imageArr || []).map(normalizeImageUrl).filter(Boolean);

  // Normalize notes response
  let notes = [];
  const nr = notesResp;
  if (Array.isArray(nr)) notes = nr;
  else if (nr && Array.isArray(nr.notes)) notes = nr.notes;

  return { ok: true, images: Array.from(new Set(imageArr)), notes };
}

async function computeNewImagesFor(sourceId, scrapedUrls = []) {
  const normScraped = (Array.isArray(scrapedUrls) ? scrapedUrls : []).map(normalizeImageUrl).filter(Boolean);
  if (!sourceId || normScraped.length === 0) return [];
  const sync = await fetchSyncDataForSource(sourceId).catch(() => ({ ok: false, images: [] }));
  const remoteSet = new Set(sync.images || []);
  const diff = normScraped.filter(u => !remoteSet.has(u));
  return Array.from(new Set(diff));
}

// Helper: perform initialization sync for a given tab/url when logged in
async function doInitSyncForTab(tabId, url) {
  try {
    const isDetail = /^https:\/\/([^./]+\.)*sahibinden\.com\/ilan\//.test(url || '');
    if (!isDetail) return;
    const res = await scrapeDetailInPage(tabId, url);
    if (res && res.success && res.data) {
      const enriched = await enrichWithExternal(res.data || {});
      const dto = mapToPropertyDto(enriched || {});
      const sourceId = dto?.id || '';
      const ilanNo = enriched['İlan No'] || sourceId || '';
      const scrapedImageUrls = Array.isArray(enriched.scrapedImageUrls) ? enriched.scrapedImageUrls : [];
      // If logged in, fetch remote sync data (notes + images) ONCE and compute diffs locally.
      const { jwt } = await getAuthAndBase();
      if (jwt && sourceId) {
        const sync = await fetchSyncDataForSource(sourceId).catch(() => ({ ok: false, images: [], notes: [] }));
        // Compute new images by diffing scraped vs. remote, without triggering another network call
        const remoteSet = new Set((sync?.images || []).map(normalizeImageUrl).filter(Boolean));
        const normScraped = scrapedImageUrls.map(normalizeImageUrl).filter(Boolean);
        const newImageUrls = Array.from(new Set(normScraped.filter(u => !remoteSet.has(u))));

        // Cache last tab data including computed new images
        lastTabData.set(tabId, { url, scraped: enriched, sourceId, ilanNo, scrapedImageUrls, newImageUrls });

        // Notify popup with the same sync payload to avoid duplicate fetches
        try {
          chrome.runtime.sendMessage({
            action: 'syncStatus',
            ok: !!sync?.ok,
            sourceId,
            ilanNo,
            notes: sync?.notes || [],
            images: sync?.images || []
          });
        } catch (_) {}
      } else {
        // Not logged in or missing sourceId: cache scraped basics without newImageUrls
        lastTabData.set(tabId, { url, scraped: enriched, sourceId, ilanNo, scrapedImageUrls, newImageUrls: [] });
      }
    }
  } catch (_) {}
}

// Auto scrape and compute sync data when a sahibinden detail page finishes loading
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  try {
    if (changeInfo.status === 'complete') {
      const url = (tab && tab.url) || changeInfo.url || '';
      const isDetail = /^https:\/\/([^./]+\.)*sahibinden\.com\/ilan\//.test(url || '');
      if (!isDetail) {
        // Clear cache for non-detail pages on completion
        lastTabData.delete(tabId);
        return;
      }
      (async () => {
        // Requirement: if no token, do nothing on initialization
        const { jwt } = await getAuthAndBase();
        if (!jwt) {
          // Skip any scraping/sync until user logs in via popup
          return;
        }
        await doInitSyncForTab(tabId, url);
      })();
    }
  } catch (_) {}
});

// Message bridge from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
  if (msg && msg.type === 'initSyncForCurrent') {
    try {
      const { tabId, url } = msg;
      const { jwt } = await getAuthAndBase();
      if (!jwt) { sendResponse({ ok: false, error: 'no_jwt' }); return; }
      await doInitSyncForTab(tabId, url);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return;
  }
    if (msg && msg.type === 'scrapeCurrent') {
      const { url, tabId } = msg;
      // Only allow detail pages
      const ok = /^https:\/\/([^./]+\.)*sahibinden\.com\/ilan\//.test(url || '');
      if (!ok) {
        sendResponse({ error: 'This is not a Sahibinden detail page.' });
        return;
      }
      const result = await scrapeDetailInPage(tabId, url);
      try {
        // Cache last scraped info for the tab and compute sync diffs
        if (result && result.success && result.data) {
          const enriched = await enrichWithExternal(result.data || {});
          const dto = mapToPropertyDto(enriched || {});
          const sourceId = dto?.id || '';
          const ilanNo = enriched['İlan No'] || sourceId || '';
          const scrapedImageUrls = Array.isArray(enriched.scrapedImageUrls) ? enriched.scrapedImageUrls : [];
          let newImageUrls = [];
          try { newImageUrls = await computeNewImagesFor(sourceId, scrapedImageUrls); } catch (_) { newImageUrls = []; }
          lastTabData.set(tabId, { url, scraped: enriched, sourceId, ilanNo, scrapedImageUrls, newImageUrls });
        }
        // Fire-and-forget auto send to API if scraping succeeded
        if (result && result.success && result.data) {
          try { chrome.runtime.sendMessage({ action: 'autoSendStart' }); } catch (_) {}
          (async () => {
            try {
              const enriched = await enrichWithExternal(result.data || {});
              const res = await postSinglePropertyToEmlak(enriched);
              // After posting main JSON, if we have images and a sourceId, upload images sequentially
              try {
                const dto = mapToPropertyDto(enriched || {});
                const sourceId = dto?.id || '';
                const scrapedUrls = Array.isArray(enriched?.scrapedImageUrls) ? enriched.scrapedImageUrls : [];
                const urls = await computeNewImagesFor(sourceId, scrapedUrls);
                if (res?.ok && sourceId && urls.length) {
                  await uploadImagesForProperty(sourceId, urls);
                }
              } catch (e) {
                console.warn('Image upload flow failed:', e);
              }
              try { chrome.runtime.sendMessage({ action: 'autoSendDone', ok: !!res?.ok, error: res?.error || null }); } catch (_) {}
            } catch (e) {
              try { chrome.runtime.sendMessage({ action: 'autoSendDone', ok: false, error: String(e && e.message ? e.message : e) }); } catch (_) {}
            }
          })();
        }
      } catch (_) {}
      sendResponse(result);
      return;
    } else if (msg && msg.type === 'emlakSend') {
      const data = await enrichWithExternal(msg.data || {});
      const res = await postSinglePropertyToEmlak(data);
      // After posting main JSON, if we have images and a sourceId, upload images sequentially
      try {
        const dto = mapToPropertyDto(data || {});
        const sourceId = dto?.id || '';
        const scrapedUrls = Array.isArray(data?.scrapedImageUrls) ? data.scrapedImageUrls : [];
        const urls = await computeNewImagesFor(sourceId, scrapedUrls);
        if (res?.ok && sourceId && urls.length) {
          await uploadImagesForProperty(sourceId, urls);
        }
      } catch (e) {
        // Non-fatal
        console.warn('Image upload flow failed:', e);
      }
      sendResponse(res);
      return;
    } else if (msg && msg.type === 'getCurrentInfo') {
      const { tabId } = msg;
      const cached = tabId ? lastTabData.get(tabId) : null;
      if (cached) {
        sendResponse({ ok: true, sourceId: cached.sourceId || '', ilanNo: cached.ilanNo || '', scrapedImageUrls: cached.scrapedImageUrls || [], newImageUrls: cached.newImageUrls || [] });
      } else {
        sendResponse({ ok: false });
      }
      return;
    } else if (msg && msg.type === 'getSyncData') {
      try {
        const { sourceId } = msg;
        const data = await fetchSyncDataForSource(sourceId);
        sendResponse(data);
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
      return;
    } else if (msg && msg.type === 'addNote') {
      const { sourceId, text, noteType } = msg;
      try {
        const { jwt, baseUrl } = await getAuthAndBase();
        if (!sourceId) {
          sendResponse({ ok: false, error: 'Missing sourceId' });
          return;
        }
        await ensureCorsBypassForBase(baseUrl);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        // Normalize note type to required uppercase values (PUBLIC/PRIVATE)
        let normType = String(noteType || '').toUpperCase();
        normType = (normType === 'PRIVATE') ? 'PRIVATE' : 'PUBLIC';
        const bodyObj = { sourceId, text: String(text || ''), type: normType, lastUpdate: null };
        const url = baseUrl.replace(/\/$/, '') + '/api/custom/property-import/add-note';
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {})
          },
          body: JSON.stringify(bodyObj),
          signal: controller.signal
        }).catch((e) => { throw e; });
        clearTimeout(timeout);
        // Emit debug log
        await emitApiDebug({ method: 'POST', url, resp });
        if (!resp || !resp.ok) {
          const txt = resp ? (await resp.text().catch(() => '')) : 'no_response';
          // Emit error detail too
          await emitApiDebug({ method: 'POST', url, error: `HTTP ${resp ? resp.status : 'NA'} ${txt}` });
          sendResponse({ ok: false, error: `HTTP ${resp ? resp.status : 'NA'} ${txt}` });
          return;
        }
        let json = null; try { json = await resp.json(); } catch { json = null; }
        // Normalize to return same shape as fetchSyncDataForSource
        let images = [];
        if (json && Array.isArray(json.images)) images = json.images.map(normalizeImageUrl).filter(Boolean);
        else if (json && Array.isArray(json.imageSourceFiles)) images = json.imageSourceFiles.map(normalizeImageUrl).filter(Boolean);
        let notes = [];
        if (json && Array.isArray(json.notes)) notes = json.notes;
        sendResponse({ ok: true, images: Array.from(new Set(images)), notes });
      } catch (e) {
        try {
          const { baseUrl } = await getAuthAndBase();
          const url = (baseUrl || '').replace(/\/$/, '') + '/api/custom/property-import/add-note';
          await emitApiDebug({ method: 'POST', url, error: String(e && e.message ? e.message : e) });
        } catch(_) {}
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
      return;
    } else if (msg && msg.type === 'emlakLogin') {
      // Perform login in background to avoid CORS issues from the popup page
      const { email, password, baseUrl } = msg;
      try {
        const res = await emlakLogin(email, password, baseUrl);
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
      return;
    } else if (msg && msg.type === 'testGeminiKey') {
      // Test Gemini API key
      const { apiKey } = msg;
      try {
        if (typeof testGeminiAPI === 'function') {
          const result = await testGeminiAPI(apiKey);
          sendResponse(result);
        } else {
          sendResponse({ ok: false, message: 'Gemini test fonksiyonu bulunamadı.' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
      return;
    }
    sendResponse({ error: 'Unknown message' });
  })();
  // Keep channel open for async response
  return true;
});

// --- CORS bypass helper via Declarative Net Request dynamic rules ---
async function ensureCorsBypassForBase(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const scheme = u.protocol.replace(':', '');
    const host = u.hostname;
    const port = u.port; // may be empty
    // Build a regexFilter that matches exactly this origin
    const origin = `${scheme}://${host}${port ? ':' + port : ''}`;
    const regexFilter = `^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*`;

    // Build a stable rule id per origin
    const idBase = 10000; // avoid clashing with static rules
    let h = 0;
    for (let i = 0; i < origin.length; i++) h = (h * 31 + origin.charCodeAt(i)) >>> 0;
    const ruleId = idBase + (h % 40000); // keep within safe range

    const rule = {
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'origin', operation: 'remove' },
          { header: 'access-control-request-headers', operation: 'remove' },
          { header: 'access-control-request-method', operation: 'remove' },
          { header: 'referer', operation: 'remove' }
        ]
      },
      condition: {
        regexFilter,
        resourceTypes: ['xmlhttprequest']
      }
    };

    // Install or replace the rule
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
      addRules: [rule]
    });
  } catch (_) {
    // Ignore – if rules API fails, network may still succeed
  }
}

// --- Helpers: mapping scraped data to expected PropertyDTO-like shape ---
function parsePriceToNumber(priceText) {
  if (!priceText) return null;
  // Remove currency symbols and non-digits except separators
  const cleaned = String(priceText)
    .replace(/[₺$,€£]/g, ' ')
    .replace(/\./g, '') // remove thousand separators
    .replace(/,/g, '.') // decimal comma → dot
    .replace(/[^0-9.\-]/g, ' ')
    .trim();
  const nums = cleaned.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return null;
  const n = Number(nums[0]);
  return Number.isFinite(n) ? n : null;
}

function parseCoordsFromMapUrl(mapUrl) {
  try {
    if (!mapUrl) return { latitude: null, longitude: null };
    const m = String(mapUrl).match(/maps\?q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lat = parseFloat(m[1]);
      const lon = parseFloat(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { latitude: lat, longitude: lon };
    }
  } catch (_) {}
  return { latitude: null, longitude: null };
}

function extractIdFromUrl(url) {
  try {
    if (!url) return '';
    // sahibinden detail URL often ends with ...-<digits>
    const m = String(url).match(/-(\d+)(?:\?|$)/);
    if (m) return m[1];
  } catch (_) {}
  return '';
}

function splitCityDistrict(locationText) {
  if (!locationText) return { city: '', district: '', neighborhood: '' };
  const parts = String(locationText).split('/').map(s => s.trim()).filter(Boolean);
  return {
    city: parts[0] || '',
    district: parts[1] || '',
    neighborhood: parts.slice(2).join(' / ') || ''
  };
}

function mapToPropertyDto(scraped) {
  const s = scraped || {};
  const url = s.URL || '';
  // Prefer explicit scraped listing number ("İlan No"), then fallback to generic ID or infer from URL
  const id = (s['İlan No'] && String(s['İlan No']).trim()) || (s.ID && String(s.ID).trim()) || extractIdFromUrl(url);
  const title = s['İlan Başlığı'] || s['Baslik'] || '';
  const description = s['Açıklama'] || '';
  const priceText = s['Fiyat'] || '';
  const price = parsePriceToNumber(priceText);
  const mapUrl = s['Harita'] || '';
  const { latitude, longitude } = parseCoordsFromMapUrl(mapUrl);
  const locText = s['İl / İlçe'] || s['Konum'] || '';
  const { city, district, neighborhood } = splitCityDistrict(locText);
  const contactName = s['Agent Adı'] || s['İletişim'] || '';
  const contactPhone = s['Agent Telefon'] || '';
  const listingFrom = s['Kimden'] || '';

  // Construct DTO – align with docs/cr.md proposed schema (server will ignore unknowns)
  const dto = {
    id: id || null,
    url,
    title,
    description,
    priceText,
    price,
    city,
    district,
    neighborhood,
    locationText: locText || '',
    mapUrl: mapUrl || '',
    parcelUrl: s['Parsel'] || '',
    latitude,
    longitude,
    contactName,
    contactPhone,
    listingFrom,
    // Enrichment fields carried from scraping/integration outputs (migrated from chrome-ext)
    frontageText: s['Cephe'] || '',
    opennessText: s['Çevre'] || '',
    frontageOpennessText: s['Cephe Çevre'] || '',
    nearestTransportText: s['En Yakın'] || '',
    summary: s['Özet'] || '',
    source: 'sahibinden',
    scrapedAt: new Date().toISOString(),
    original: s
  };
  return dto;
}

// Post a single scraped object to the Emlak API using stored JWT
async function postSinglePropertyToEmlak(obj) {
  try {
    const vals = await new Promise((res) => chrome.storage.local.get(['sahi:jwt', 'sahi:emlakUrl'], res));
    const jwt = vals['sahi:jwt'];
    const baseUrl = RESOLVE_EMLAK_BASE_URL(vals['sahi:emlakUrl']);
    if (!jwt) {
      return { ok: false, reason: 'no_jwt', error: 'No JWT in storage. Please login.' };
    }

    const payload = mapToPropertyDto(obj);

    const tryRequest = async (path, method) => {
      await ensureCorsBypassForBase(baseUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const url = baseUrl + path;
      const resp = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'accept': '*/*',
          'Authorization': `Bearer ${jwt}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      }).catch((e) => { throw e; });
      clearTimeout(timeout);
      // Emit attempt debug
      await emitApiDebug({ method, url, resp });
      return resp;
    };

    let resp = null;
    let lastErrText = '';
    const attempts = [];

    // Helper to run an attempt and record diagnostic
    const run = async (path, method) => {
      try {
        const r = await tryRequest(path, method);
        attempts.push(`${method} ${path} -> ${r.status}`);
        return r;
      } catch (e) {
        const msg = String(e && e.message || e);
        attempts.push(`${method} ${path} -> error: ${msg}`);
        lastErrText = msg;
        try { await emitApiDebug({ method, url: baseUrl + path, error: msg }); } catch(_) {}
        return null;
      }
    };

    // 1) Try new import endpoint first, then old plural path; on 405 also try PUT
    resp = await run('/api/custom/property-import', 'POST');
    if ((!resp || !resp.ok) && (!resp || resp.status === 404 || resp.status === 405)) {
      // Backward compatibility: older plural endpoint
      resp = await run('/api/custom/properties/import', 'POST');
      if (resp && resp.status === 405) {
        // Some servers expect PUT for import
        resp = await run('/api/custom/properties/import', 'PUT');
      }
    }
    if (!resp || !resp.ok) {
      resp = await run('/api/properties/import', 'POST');
      if (resp && resp.status === 405) {
        resp = await run('/api/properties/import', 'PUT');
      }
    }

    // 2) If import still not accepted, try generic collection endpoints (create)
    if (!resp || !resp.ok) {
      resp = await run('/api/custom/properties', 'POST');
      if (resp && resp.status === 405) {
        resp = await run('/api/custom/properties', 'PUT');
      }
    }
    if (!resp || !resp.ok) {
      resp = await run('/api/properties', 'POST');
      if (resp && resp.status === 405) {
        resp = await run('/api/properties', 'PUT');
      }
    }

    if (!resp || !resp.ok) {
      const status = resp ? resp.status : 'no_response';
      let tail = '';
      if (resp) {
        let txt = await resp.text().catch(() => '');
        // Try to parse problem+fieldErrors to surface validation issues
        try {
          const j = JSON.parse(txt);
          if (j && j.fieldErrors) {
            const fields = j.fieldErrors.map(fe => `${fe.field}: ${fe.message || fe.error}`).join(', ');
            txt = `${j.title || 'Validation error'} [${fields}]`;
          }
        } catch(_) {}
        tail = txt ? `: ${txt.substring(0, 500)}` : (lastErrText ? `: ${lastErrText}` : '');
      } else if (lastErrText) {
        tail = `: ${lastErrText}`;
      }
      const diag = attempts.length ? ` | attempts: ${attempts.join(' ; ')}` : '';
      return { ok: false, status, error: `Emlak send failed ${tail}${diag}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// --- Helpers for image upload flow ---
function randInt(min, max) {
  min = Math.ceil(min); max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// Fetch an image URL and return { contentType, width, height, source(base64) }
async function fetchImageInfo(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const resp = await fetch(url, { credentials: 'omit', signal: controller.signal }).catch((e)=>{ throw e; });
  clearTimeout(timeout);
  if (!resp || !resp.ok) throw new Error(`HTTP ${resp ? resp.status : 'ERR'}`);
  const contentType = resp.headers.get('content-type') || '';
  const blob = await resp.blob();
  let width = 0, height = 0;
  try {
    const bmp = await createImageBitmap(blob);
    width = bmp.width || 0; height = bmp.height || 0;
    bmp.close && bmp.close();
  } catch {}
  const dataUrl = await new Promise((resolve, reject) => {
    try {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('FileReader error'));
      fr.onloadend = () => resolve(fr.result);
      fr.readAsDataURL(blob);
    } catch (e) { reject(e); }
  });
  let base64 = '';
  try {
    const idx = String(dataUrl).indexOf('base64,');
    base64 = idx >= 0 ? String(dataUrl).slice(idx + 7) : '';
  } catch {}
  return { contentType, width, height, source: base64 };
}

async function postSingleImageToEmlak({ sourceId, sourceFile, image }) {
  const vals = await new Promise(res => chrome.storage.local.get(['sahi:jwt','sahi:emlakUrl'], res));
  const jwt = vals['sahi:jwt'];
  const baseUrl = RESOLVE_EMLAK_BASE_URL(vals['sahi:emlakUrl']);
  if (!jwt) return { ok: false, reason: 'no_jwt' };
  await ensureCorsBypassForBase(baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const url = baseUrl + '/api/custom/property-import/image';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
    body: JSON.stringify({ sourceId, sourceFile, image }),
    signal: controller.signal
  }).catch((e)=>{ throw e; });
  clearTimeout(timeout);
  try { await emitApiDebug({ method: 'POST', url, resp }); } catch(_) {}
  let data = null; try { data = await resp.json(); } catch {}
  return { ok: !!resp.ok, status: resp.status, data };
}

async function uploadImagesForProperty(sourceId, imageUrls = []) {
  if (!sourceId || !Array.isArray(imageUrls) || imageUrls.length === 0) return { ok: true, count: 0 };
  const total = imageUrls.length; let imported = 0;
  try { chrome.runtime.sendMessage({ action: 'imageImportStart', total, sourceId }); } catch(_) {}
  for (const imgUrl of imageUrls) {
    try {
      await sleep(randInt(3000, 6000));
      const info = await fetchImageInfo(imgUrl);
      if (!info || !info.source) {
        // Nothing fetched; skip this image but continue the flow
        try { chrome.runtime.sendMessage({ action: 'imageImportProgress', imported, total, sourceId }); } catch(_) {}
        continue;
      }
      // Server expects image DTO: { base64: DataURL, width, height, source }
      // Build a proper Data URL using content-type and the fetched base64 payload
      const mimeFromUrl = (() => {
        try {
          const u = new URL(imgUrl);
          const pathname = u.pathname || '';
          if (/\.png$/i.test(pathname)) return 'image/png';
          if (/\.jpe?g$/i.test(pathname)) return 'image/jpeg';
          if (/\.webp$/i.test(pathname)) return 'image/webp';
          if (/\.gif$/i.test(pathname)) return 'image/gif';
        } catch (_) {}
        return '';
      })();
      const ct = info?.contentType || mimeFromUrl || 'image/jpeg';
      const rawBase64 = info?.source || '';
      if (!rawBase64) {
        try { chrome.runtime.sendMessage({ action: 'imageImportProgress', imported, total, sourceId }); } catch(_) {}
        continue;
      }
      const dataUrl = rawBase64 && rawBase64.startsWith('data:')
        ? rawBase64
        : `data:${ct};base64,${rawBase64}`;

      // Save a copy of the image into the Downloads folder using the image name
      try {
        const deriveImageFilename = (urlStr, contentType) => {
          try {
            const u = new URL(urlStr);
            let name = (u.pathname.split('/').pop() || '').split('?')[0] || 'image';
            // ensure extension
            if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) {
              const ext = contentType?.includes('png') ? 'png'
                : contentType?.includes('gif') ? 'gif'
                : contentType?.includes('webp') ? 'webp'
                : 'jpg';
              name = name + '.' + ext;
            }
            return name;
          } catch (_) {
            return 'image.jpg';
          }
        };
        // Save into a subfolder under the default Downloads directory
        // Chrome downloads API only allows a relative path; this will create
        // ~/Downloads/scrapped/ on macOS (or the equivalent on other OSes)
        const filename = 'scrapped/' + deriveImageFilename(imgUrl, ct);
        // Use Chrome downloads API; conflictAction to keep multiple copies if needed
        console.log('image ', filename);
        chrome.downloads?.download({ url: dataUrl, filename, saveAs: false, conflictAction: 'uniquify' });
      } catch (_) {}

      const image = {
        base64: dataUrl,
        width: info?.width || 0,
        height: info?.height || 0,
        // Use stable identifier for source; keep original host if available
        source: (() => { try { return new URL(imgUrl).hostname || 'sahibinden.com'; } catch (_) { return 'sahibinden.com'; } })()
      };
      const res = await postSingleImageToEmlak({ sourceId, sourceFile: imgUrl, image });
      if (res && res.ok) imported++;
    } catch (e) {
      console.warn('Image upload failed:', e);
    }
    try { chrome.runtime.sendMessage({ action: 'imageImportProgress', imported, total, sourceId }); } catch(_) {}
  }
  try { chrome.runtime.sendMessage({ action: 'imageImportDone', imported, total, sourceId }); } catch(_) {}
  return { ok: true, count: imported };
}

// Login to Emlak API from background using fetch (XMLHttpRequest is not available in MV3 service workers)
async function emlakLogin(email, password, baseUrlInput) {
  const baseUrl = RESOLVE_EMLAK_BASE_URL(baseUrlInput);
  const bodyStr = JSON.stringify({ username: email, email, password, rememberMe: false });
  const tryPaths = ['/api/custom/authenticate', '/api/authenticate'];

  const tryFetch = async (path) => {
    await ensureCorsBypassForBase(baseUrl);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20000);
    try {
      const url = baseUrl + path;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'accept': '*/*' },
        body: bodyStr,
        signal: controller.signal
      });
      clearTimeout(t);
      try { await emitApiDebug({ method: 'POST', url, resp }); } catch(_) {}
      return resp;
    } catch (e) {
      clearTimeout(t);
      try { await emitApiDebug({ method: 'POST', url: baseUrl + path, error: String(e && e.message || e) }); } catch(_) {}
      throw e;
    }
  };

  let lastErr = '';
  for (const p of tryPaths) {
    try {
      const resp = await tryFetch(p);
      if (resp.ok) {
        // parse token (JSON or plain text)
        let token = '';
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const data = await resp.json().catch(() => ({}));
          token = typeof data === 'string' ? data : (data.id_token || data.token || data.jwt || '');
        } else {
          token = (await resp.text()).trim();
        }
        if (!token) return { ok: false, error: 'Sunucudan token alınamadı.' };
        return { ok: true, token, baseUrl };
      } else if (resp.status === 404 || resp.status === 405 || resp.status === 401) {
        lastErr = `HTTP ${resp.status}`;
        continue; // try next path
      } else {
        const txt = await resp.text().catch(() => '');
        const tail = txt ? `: ${txt.substring(0, 300)}` : '';
        return { ok: false, error: `HTTP ${resp.status}${tail}` };
      }
    } catch (e) {
      lastErr = String(e && e.message || e);
    }
  }
  return { ok: false, error: lastErr || 'Kimlik doğrulama başarısız.' };
}
