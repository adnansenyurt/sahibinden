(() => {
    try {
        console.log('[sahi] content script boot', location.href);
        
        // Enhanced domain validation (broaden to all subdomains)
        const host = location.hostname;
        const isAllowedHost = host === 'sahibinden.com' || host.endsWith('.sahibinden.com');
        if (!isAllowedHost) {
            console.log(`[sahi] not allowed host: ${host}`);
            return;
        }

        // More reliable injection detection
        const EXTENSION_ID = 'sahi-notes-extension';
        if (window[EXTENSION_ID]) {
            console.log('Extension already initialized');
            return;
        }
        window[EXTENSION_ID] = true;

        // Initialize only after DOM is fully loaded
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initializeExtension, { passive: true });
        } else {
            initializeExtension();
        }

        function initializeExtension() {
            try {
                // Add initialization marker
                const marker = document.createElement('div');
                marker.style.display = 'none';
                marker.className = 'sahi-extension-initialized';
                document.body.appendChild(marker);

                // ---- Config ----
                const API_BASE = 'http://localhost:3000';
                const DEBOUNCE_MS = 500;
                const ROW_SEL = '#searchResultsTable tbody tr.searchResultsItem';

                // ---- Cache ----
                let notesCache = {};
                let savingQueue = new Map();
                let debounceTimers = new Map();
                let activeNoteBox = null;
                let observers = [];
                let noteBoxes = new Map();
                const positionTrackers = new Map(); // adId -> stopTracking()
                const hoverStates = new Map(); // adId -> { overRow, overBox, tid }

                // Load local cache initially
                (async function bootstrap() {
                  notesCache = await getAllNotesLocal();
                  updateStarIcons();
                })();

                // ---- Local storage helpers ----
                async function getAllNotesLocal() {
                  const { noteIndex = {} } = await chrome.storage.local.get('noteIndex');
                  const keys = Object.keys(noteIndex).map(id => `note:${id}`);
                  if (!keys.length) return {};
                  const res = await chrome.storage.local.get(keys);
                  const map = {};
                  for (const k of Object.keys(res)) {
                    if (k.startsWith('note:')) {
                      const adId = k.slice(5);
                      const v = res[k];
                      // support plain string or full object
                      map[adId] = typeof v === 'string' ? { note: v, updatedAt: null, version: 0 } : v;
                    }
                  }
                  return map;
                }

                async function setNoteLocal(adId, obj) {
                  const key = `note:${adId}`;
                  const { noteIndex = {} } = await chrome.storage.local.get('noteIndex');
                  noteIndex[adId] = 1;
                  await chrome.storage.local.set({ [key]: obj, noteIndex });
                }

                // ---- UI Integration (existing) ----
                function updateStarIcons() {
                  try {
                    document.querySelectorAll(ROW_SEL).forEach(row => {
                      const adId = getAdId(row);
                      const hasNote = !!notesCache[adId]?.note?.trim();
                      row.classList.toggle('sahi-has-note', hasNote);
                    });
                  } catch (e) {}
                }

                // Helper: robust adId extraction + debug
                function getAdId(row) {
                  if (!row) return null;
                  const fromData = row.getAttribute('data-id') || row.dataset?.id;
                  if (fromData) return fromData;
                  const idAttr = row.getAttribute('id');
                  if (idAttr) {
                    const digits = idAttr.match(/\d+/)?.[0];
                    if (digits) return digits;
                  }
                  const a = row.querySelector('a[href*="/ilan/"], a[href*="/detay/"], a[href*="ilan/"]');
                  if (a?.href) {
                    const m = a.href.match(/\/(\d+)(?:\?|$|\/)/);
                    if (m) return m[1];
                  }
                  return null;
                }

                // Called when user edits a note
                function onNoteChanged(adId, text) {
                  const nowIso = new Date().toISOString();
                  notesCache[adId] = { note: text, updatedAt: nowIso, version: (notesCache[adId]?.version ?? 0) };
                  setNoteLocal(adId, notesCache[adId]);
                  updateStarIcons();
                  queueSave(adId, text, nowIso);
                }

                function queueSave(adId, text, updatedAt) {
                  savingQueue.set(adId, { text, updatedAt });
                  clearTimeout(debounceTimers.get(adId));
                  debounceTimers.set(adId, setTimeout(() => flushSave(adId), DEBOUNCE_MS));
                }

                // ---- REST write (debounced) ----
                async function flushSave(adId) {
                  const pending = savingQueue.get(adId);
                  if (!pending) return;
                  const { text, updatedAt } = pending;
                  const token = (await chrome.storage.local.get('jwtToken')).jwtToken || '';
                  try {
                    const res = await fetch(`${API_BASE}/api/notes/${encodeURIComponent(adId)}`, {
                      method: 'PUT',
                      headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                      },
                      body: JSON.stringify({
                        note: text || '',
                        updatedAt: updatedAt,
                        version: notesCache[adId]?.version ?? 0
                      })
                    });

                    if (res.status === 409) {
                      const server = await res.json(); // { adId, note, updatedAt, version }
                      // server is newer -> accept server
                      notesCache[adId] = server;
                      await setNoteLocal(adId, server);
                      renderNoteIfVisible(adId, server.note); // your existing UI setter
                      updateStarIcons();
                    } else if (res.ok) {
                      const server = await res.json();
                      notesCache[adId] = server;
                      await setNoteLocal(adId, server);
                    }
                  } catch (e) {
                    // offline/network error: keep local; optional retry/backoff here
                  } finally {
                    savingQueue.delete(adId);
                    clearTimeout(debounceTimers.get(adId));
                  }
                }

                // ---- Pull on demand ("Sync Notes" from popup) ----
                chrome.runtime.onMessage.addListener((msg) => {
                  if (msg?.type === 'SYNC_NOTES_NOW') pullFromServer();
                });

                async function pullFromServer() {
                  const token = (await chrome.storage.local.get('jwtToken')).jwtToken || '';
                  const { lastSyncAt } = await chrome.storage.local.get('lastSyncAt');
                  const qs = lastSyncAt ? `?since=${encodeURIComponent(lastSyncAt)}` : '';
                  try {
                    const resp = await fetch(`${API_BASE}/api/notes${qs}`, {
                      headers: { 'Authorization': `Bearer ${token}` }
                    });
                    if (!resp.ok) return;
                    const data = await resp.json(); // { items: [...], serverTime: "..." }
                    const items = data.items || [];
                    for (const it of items) {
                      const cur = notesCache[it.adId];
                      if (!cur || !cur.updatedAt || new Date(it.updatedAt) >= new Date(cur.updatedAt)) {
                        notesCache[it.adId] = it;
                        await setNoteLocal(it.adId, it);
                        renderNoteIfVisible(it.adId, it.note);
                      }
                    }
                    await chrome.storage.local.set({ lastSyncAt: data.serverTime || new Date().toISOString() });
                    updateStarIcons();
                  } catch (e) {
                    // network error -> ignore; user can retry
                  }
                }

                // ---- Helpers you already have (stubs here) ----
                // Keep open editor in sync when notes pulled/updated
                function renderNoteIfVisible(adId, note) {
                  try {
                    const host = noteBoxes.get(adId);
                    if (host?.shadowRoot) {
                      const ta = host.shadowRoot.querySelector('textarea');
                      if (ta) ta.value = note || '';
                    }
                  } catch (_) {}
                }

                // Position helper (render to body, avoid clipping)
                function positionNoteBox(host, row) {
                    const rect = row.getBoundingClientRect();
                    const width = 240; // desired box width
                    const height = Math.max(60, rect.height); // ensure a minimum height
                    // Prefer left; if not enough space, place to the right
                    const preferLeft = rect.left >= width + 8;
                    const left = preferLeft ? (rect.left - width - 8) : Math.min(window.innerWidth - width - 4, rect.right + 8);
                    const top = Math.max(4, Math.min(window.innerHeight - height - 4, rect.top));
                    host.style.position = 'fixed';
                    host.style.top = `${top}px`;
                    host.style.left = `${left}px`;
                    host.style.height = `${height}px`;
                    host.style.width = `${width}px`;
                    host.style.zIndex = '2147483647';
                    host.style.pointerEvents = 'auto';
                }

                function startPositionTracking(adId, row, host) {
                    const onPosition = () => positionNoteBox(host, row);
                    window.addEventListener('scroll', onPosition, { passive: true });
                    window.addEventListener('resize', onPosition, { passive: true });
                    // Initial position
                    onPosition();
                    positionTrackers.set(adId, () => {
                        window.removeEventListener('scroll', onPosition);
                        window.removeEventListener('resize', onPosition);
                    });
                }

                function stopPositionTracking(adId) {
                    const stop = positionTrackers.get(adId);
                    if (stop) {
                        try { stop(); } catch (_) {}
                        positionTrackers.delete(adId);
                    }
                }

                // Defer-close logic so moving from row -> box doesn't instantly close it
                function closeNoteBox(adId) {
                    stopPositionTracking(adId);
                    const host = noteBoxes.get(adId);
                    if (host?.isConnected) {
                        try { host.remove(); } catch (_) {}
                    }
                    noteBoxes.delete(adId);
                    const state = hoverStates.get(adId);
                    if (state?.tid) clearTimeout(state.tid);
                    hoverStates.delete(adId);
                }

                function maybeClose(adId) {
                    const state = hoverStates.get(adId);
                    if (!state) return;
                    if (state.tid) clearTimeout(state.tid);
                    state.tid = setTimeout(() => {
                        if (!state.overRow && !state.overBox) {
                            closeNoteBox(adId);
                        }
                    }, 200); // small grace period
                }

                function openNoteBox(adId, row) {
                    if (noteBoxes.has(adId)) return noteBoxes.get(adId);
                    const host = createNoteBox(adId);
                    if (!host) return null;

                    // ensure state
                    const state = hoverStates.get(adId) || { overRow: true, overBox: false, tid: null };
                    hoverStates.set(adId, state);

                    document.body.appendChild(host);
                    positionNoteBox(host, row);
                    startPositionTracking(adId, row, host);
                    noteBoxes.set(adId, host);

                    const cancelClose = () => {
                        const s = hoverStates.get(adId);
                        if (s?.tid) { clearTimeout(s.tid); s.tid = null; }
                    };

                    // Keep alive when hovering the floating box
                    host.addEventListener('mouseenter', () => {
                        const s = hoverStates.get(adId);
                        if (!s) return;
                        s.overBox = true;
                        cancelClose();
                    }, { passive: true });

                    host.addEventListener('mouseleave', () => {
                        const s = hoverStates.get(adId);
                        if (!s) return;
                        s.overBox = false;
                        maybeClose(adId);
                    }, { passive: true });

                    // Optional: focus textarea for quick typing
                    setTimeout(() => {
                        try { host.shadowRoot.querySelector('textarea')?.focus(); } catch (_) {}
                    }, 0);

                    return host;
                }

                function createNoteBox(adId) {
                    try {
                        const host = document.createElement('div');
                        host.setAttribute('data-sahi-ad-id', adId);
                        const shadow = host.attachShadow({ mode: 'open' });
                        
                        const style = document.createElement('style');
                        style.textContent = `
                            .note-box {
                                width: 100%;
                                height: 100%;
                                background: #fff;
                                border: 1px solid #ccc;
                                padding: 8px;
                                box-sizing: border-box;
                                box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                                border-radius: 4px;
                            }
                            textarea {
                                width: 100%;
                                height: 100%;
                                border: none;
                                outline: none;
                                resize: none;
                                box-sizing: border-box;
                                font: 12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Apple Color Emoji','Segoe UI Emoji', 'Segoe UI Symbol';
                            }
                        `;
                        
                        const box = document.createElement('div');
                        box.className = 'note-box';
                        box.innerHTML = '<textarea placeholder="Add note..."></textarea>';
                        const textarea = box.querySelector('textarea');
                        textarea.value = notesCache[adId]?.note || '';
                        textarea.addEventListener('input', (e) => onNoteChanged(adId, e.target.value), { passive: true });
                        
                        shadow.appendChild(style);
                        shadow.appendChild(box);
                        return host;
                    } catch (err) {
                        console.error('Error creating note box:', err);
                        return null;
                    }
                }

                function attachNoteBox(row) {
                  try {
                    if (!row) return;
                    const adId = getAdId(row);
                    if (!adId) {
                      console.debug('[sahi] skip row (no adId)');
                      return;
                    }

                    if (row.__sahiWired) return;
                    row.__sahiWired = true;

                    console.debug('[sahi] wiring row', adId);

                    row.addEventListener('mouseenter', () => {
                      console.log('[sahi] row enter', adId);
                      row.style.outline = '3px solid red';
                      row.style.outlineOffset = '-1px';

                      const state = hoverStates.get(adId) || { overRow: false, overBox: false, tid: null };
                      state.overRow = true;
                      hoverStates.set(adId, state);
                      const wasOpen = noteBoxes.has(adId);
                      const host = openNoteBox(adId, row);
                      if (!wasOpen && host) console.debug('[sahi] opened note box for', adId);
                    }, { passive: true });

                    row.addEventListener('mouseleave', () => {
                      console.log('[sahi] row leave', adId);
                      row.style.outline = '';
                      row.style.outlineOffset = '';

                      const state = hoverStates.get(adId);
                      if (!state) return;
                      state.overRow = false;
                      hoverStates.set(adId, state);
                      maybeClose(adId);
                    }, { passive: true });
                  } catch (err) {
                    console.error('Error attaching note box:', err);
                  }
                }

                function init() {
                  try {
                    // Helper to wire all current rows
                    const wireAll = (root = document) => {
                      const rows = root.querySelectorAll(ROW_SEL);
                      console.log(`[sahi] found ${rows.length} rows for selector: ${ROW_SEL}`);
                      rows.forEach(attachNoteBox);
                    };

                    // Observe the specific table body if present; otherwise observe body until it appears
                    const tableTbody = document.querySelector('#searchResultsTable tbody');
                    const observer = new MutationObserver((mutations) => {
                      let added = 0;
                      for (const m of mutations) {
                        if (m.type !== 'childList') continue;
                        m.addedNodes.forEach(node => {
                          if (node.nodeType !== 1) return;
                          if (node.matches?.(ROW_SEL)) {
                            attachNoteBox(node);
                            added++;
                          } else {
                            const rows = node.querySelectorAll?.(ROW_SEL);
                            if (rows?.length) {
                              rows.forEach(attachNoteBox);
                              added += rows.length;
                            }
                          }
                        });
                      }
                      if (added) console.log(`[sahi] mutation wired ${added} row(s)`);
                    });

                    if (tableTbody) {
                      observer.observe(tableTbody, { childList: true, subtree: true });
                      console.log('[sahi] observing #searchResultsTable tbody');
                      wireAll(tableTbody);
                    } else {
                      observer.observe(document.body, { childList: true, subtree: true });
                      console.log('[sahi] tbody not found; observing document.body');
                      wireAll(document);
                    }

                    // Cleanup
                    window.addEventListener('unload', () => {
                      observer.disconnect();
                      for (const adId of noteBoxes.keys()) closeNoteBox(adId);
                    }, { passive: true });

                    console.log('[sahi] init complete');
                  } catch (err) {
                    console.error('Error during init:', err);
                  }
                }

                // ---- Start observing mutations to attach note boxes ----
                init();
            } catch (err) {
                console.error('Error initializing extension:', err);
            }
        }
    } catch (e) {
        console.error('Global error handler:', e);
    }
})();
