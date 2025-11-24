// Lightweight background service worker for detail page scraping only

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

// Message bridge from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === 'scrapeCurrent') {
      const { url, tabId } = msg;
      // Only allow detail pages
      const ok = /^https:\/\/([^./]+\.)*sahibinden\.com\/ilan\//.test(url || '');
      if (!ok) {
        sendResponse({ error: 'This is not a Sahibinden detail page.' });
        return;
      }
      const result = await scrapeDetailInPage(tabId, url);
      sendResponse(result);
      return;
    } else if (msg && msg.type === 'emlakSend') {
      const data = msg.data;
      const res = await postSinglePropertyToEmlak(data);
      sendResponse(res);
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
    const baseUrl = (vals['sahi:emlakUrl'] || 'http://localhost:8080').replace(/\/$/, '');
    if (!jwt) {
      return { ok: false, reason: 'no_jwt', error: 'No JWT in storage. Please login.' };
    }

    const payload = mapToPropertyDto(obj);

    const tryRequest = async (path, method) => {
      await ensureCorsBypassForBase(baseUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const resp = await fetch(baseUrl + path, {
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

// Login to Emlak API from background using fetch (XMLHttpRequest is not available in MV3 service workers)
async function emlakLogin(email, password, baseUrlInput) {
  const baseUrl = (baseUrlInput || 'http://localhost:8080').replace(/\/$/, '');
  const bodyStr = JSON.stringify({ username: email, email, password, rememberMe: false });
  const tryPaths = ['/api/custom/authenticate', '/api/authenticate'];

  const tryFetch = async (path) => {
    await ensureCorsBypassForBase(baseUrl);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20000);
    try {
      const resp = await fetch(baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'accept': '*/*' },
        body: bodyStr,
        signal: controller.signal
      });
      clearTimeout(t);
      return resp;
    } catch (e) {
      clearTimeout(t);
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
