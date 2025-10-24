(() => {
  try {
    const host = location.hostname;
    const isAllowedHost = host === 'sahibinden.com' || host.endsWith('.sahibinden.com');
    if (!isAllowedHost) {
      return;
    }

    const EXTENSION_ID = 'sahi-hover-logger';
    if (window[EXTENSION_ID]) return;
    window[EXTENSION_ID] = true;

    const ROW_SEL = '#searchResultsTable tbody tr.searchResultsItem';
    
    // ---- Page lock state (per-page) ----
    const LOCK_KEY_PREFIX = 'sahi:lock:';
    const LOCK_TS_PREFIX = 'sahi:lock:ts:';
    const pageKey = () => encodeURIComponent(location.origin + location.pathname + location.search);
    const lockKey = () => `${LOCK_KEY_PREFIX}${pageKey()}`;
    const lastUnlockKey = () => `${LOCK_TS_PREFIX}${pageKey()}`;
    const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes
    let unlockTimerId = null;

    function isPageUnlocked() {
      try { return (localStorage.getItem(lockKey()) || 'locked') === 'unlocked'; } catch { return false; }
    }
    function getLastUnlockTs() {
      try {
        const v = localStorage.getItem(lastUnlockKey());
        return v ? Number(v) : 0;
      } catch { return 0; }
    }
    function setLastUnlockTs(ms) {
      try { localStorage.setItem(lastUnlockKey(), String(ms || Date.now())); } catch {}
    }
    function clearAutoRelockTimer() {
      if (unlockTimerId) {
        clearTimeout(unlockTimerId);
        unlockTimerId = null;
      }
    }
    function scheduleAutoRelock() {
      clearAutoRelockTimer();
      if (!isPageUnlocked()) return;
      let ts = getLastUnlockTs();
      if (!ts) { ts = Date.now(); setLastUnlockTs(ts); }
      const remaining = ts + AUTO_LOCK_MS - Date.now();
      if (remaining <= 0) {
        setPageLocked(true);
        return;
      }
      unlockTimerId = setTimeout(() => {
        setPageLocked(true);
      }, remaining);
    }
    function setPageLocked(locked) {
      try { localStorage.setItem(lockKey(), locked ? 'locked' : 'unlocked'); } catch {}
      if (!locked) {
        setLastUnlockTs(Date.now());
        scheduleAutoRelock();
      } else {
        clearAutoRelockTimer();
      }
      updateLockButtonUI();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
      initialize();
    }

    let OPEN_ROW = null;

    const SAVE_DEBOUNCE_MS = 300;
    const saveTimers = new Map();
    const noteKey = (id) => `sahi:note:${id}`;
    function loadNote(adId) {
      try { return localStorage.getItem(noteKey(adId)) || ''; } catch { return ''; }
    }
    function scheduleSave(adId, text) {
      clearTimeout(saveTimers.get(adId));
      const t = setTimeout(() => {
        try { localStorage.setItem(noteKey(adId), text || ''); } catch {}
        saveTimers.delete(adId);
      }, SAVE_DEBOUNCE_MS);
      saveTimers.set(adId, t);
    }

    // Helper: compute and apply box position aligned to the image; clamp in viewport
    function positionNoteBox(row, box) {
      const firstCell = row.cells?.[0] || row.querySelector('td:first-child') || row;
      const cellRect = firstCell.getBoundingClientRect ? firstCell.getBoundingClientRect() : row.getBoundingClientRect();
      const img = firstCell.querySelector?.('img');
      const refRect = img?.getBoundingClientRect ? img.getBoundingClientRect() : cellRect;

      const BOX_WIDTH = 220;
      const height = Math.max(24, refRect.height);

      // Prefer right of the image; if not enough space, place to the left of the cell
      let left = refRect.right + 8;
      if (left + BOX_WIDTH > window.innerWidth - 4) {
        left = Math.max(4, cellRect.left - BOX_WIDTH - 8);
      }

      const top = Math.max(4, Math.min(window.innerHeight - height - 4, refRect.top));

      box.style.top = `${top}px`;
      box.style.left = `${left}px`;
      box.style.height = `${height}px`;
      box.style.width = `${BOX_WIDTH}px`;
    }

    // Helper to force-close a row's note box and clear styles
    function forceCloseRow(row) {
      if (!row) return;
      row.__sahiRowHover = false;
      row.__sahiBoxHover = false;
      try { row.__sahiPosCleanup?.(); } catch (_) {}
      row.__sahiPosCleanup = null;
      try { row.__sahiImgResizeObs?.disconnect?.(); } catch (_) {}
      row.__sahiImgResizeObs = null;
      if (row.__sahiNoteBox?.isConnected) {
        try { row.__sahiNoteBox.remove(); } catch (_) {}
      }
      row.__sahiNoteBox = null;
      row.style.outline = '';
      row.style.outlineOffset = '';
    }

    // Small star overlay helpers
    function ensureStar(row) {
      try {
        const firstCell = row.cells?.[0] || row.querySelector('td:first-child') || row;
        if (!firstCell) return;
        // Make sure star positions correctly
        if (getComputedStyle(firstCell).position === 'static') {
          firstCell.style.position = 'relative';
        }
        // If star already exists, nothing to do
        if (row.__sahiStarEl?.isConnected) return;

        const star = document.createElement('div');
        star.className = 'sahi-note-star';
        star.textContent = '★';
        Object.assign(star.style, {
          position: 'absolute',
          top: '4px',
          right: '4px',
          fontSize: '16px',
          lineHeight: '16px',
          color: '#f5c518', // gold-ish
          textShadow: '0 1px 2px rgba(0,0,0,0.35)',
          pointerEvents: 'none',
          userSelect: 'none'
        });
        firstCell.appendChild(star);
        row.__sahiStarEl = star;
      } catch (_) {}
    }

    function removeStar(row) {
      try {
        if (row.__sahiStarEl?.isConnected) row.__sahiStarEl.remove();
      } catch (_) {}
      row.__sahiStarEl = null;
    }

    function refreshRowStar(row) {
      const adId = getAdId(row);
      if (!adId) {
        // Retry once shortly after in case DOM populates later
        if (!row.__sahiStarRetry) {
          row.__sahiStarRetry = true;
          setTimeout(() => {
            row.__sahiStarRetry = false;
            refreshRowStar(row);
          }, 300);
        }
        removeStar(row);
        return;
      }
      const note = loadNote(adId);
      if ((note || '').trim()) ensureStar(row);
      else removeStar(row);
    }

    // New: refresh stars for all current rows
    function refreshAllStars() {
      document.querySelectorAll(ROW_SEL).forEach(refreshRowStar);
    }

    // ---- Token helpers (chrome.storage.local with localStorage fallback) ----
    const getLocal = (k) => new Promise((res) => {
      if (chrome?.storage?.local) chrome.storage.local.get(k, v => res(v?.[k]));
      else res(null);
    });
    const setLocal = (obj) => new Promise((res) => {
      if (chrome?.storage?.local) chrome.storage.local.set(obj, res);
      else { Object.entries(obj).forEach(([k, v]) => { try { localStorage.setItem(k, v || ''); } catch {} }); res(); }
    });

    async function getStoredToken() {
      const fromChrome = await getLocal('sahi:jwt');
      if (fromChrome) return fromChrome;
      try { return localStorage.getItem('sahi:jwt') || ''; } catch { return ''; }
    }
    async function setStoredToken(t) {
      await setLocal({ 'sahi:jwt': t || '' });
      try { localStorage.setItem('sahi:jwt', t || ''); } catch {}
    }
    async function ensureToken(interactive = true) {
      let t = await getStoredToken();
      if (!t && interactive) {
        t = prompt('Enter API token for notes sync') || '';
        if (t) await setStoredToken(t);
      }
      return t;
    }

    // ---- Sync logic (shared by popup and in-page button) ----
    const SERVER_BASE = 'http://localhost:3000';
    function collectAllNotes() {
      const items = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || !k.startsWith('sahi:note:')) continue;
          const adId = k.slice('sahi:note:'.length);
          const note = localStorage.getItem(k) || '';
          if ((note || '').trim()) items.push({ adId, note });
        }
      } catch (_) {}
      return items;
    }
    async function postNote(adId, note, token) {
      return fetch(`${SERVER_BASE}/api/notes/${encodeURIComponent(adId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token || ''}`
        },
        mode: 'cors',
        body: JSON.stringify({ note })
      });
    }
    async function doSyncNotes() {
      const items = collectAllNotes();
      if (!items.length) return { ok: true, count: 0 };
      let token = await ensureToken(true);
      if (!token) return { ok: false, error: 'no_token' };

      for (const it of items) {
        try {
          let res = await postNote(it.adId, it.note, token);
          if (res.status === 401) {
            token = await ensureToken(true);
            if (!token) return { ok: false, error: 'no_token' };
            res = await postNote(it.adId, it.note, token);
          }
          if (!res.ok) return { ok: false, error: 'http' };
        } catch {
          return { ok: false, error: 'network' };
        }
      }
      return { ok: true, count: items.length };
    }

    function setSyncBtnState(btn, label, loading) {
      btn.textContent = label;
      btn.disabled = !!loading;
      btn.style.opacity = loading ? '0.7' : '1';
      btn.style.cursor = loading ? 'default' : 'pointer';
    }

    async function syncAllNotes(btn) {
      const items = collectAllNotes();
      if (!items.length) {
        setSyncBtnState(btn, 'No notes', false);
        setTimeout(() => setSyncBtnState(btn, 'Sync notes', false), 1200);
        return;
      }
      setSyncBtnState(btn, 'Syncing…', true);

      let token = await ensureToken(true);
      if (!token) {
        setSyncBtnState(btn, 'Token required', false);
        setTimeout(() => setSyncBtnState(btn, 'Sync notes', false), 1500);
        return;
      }

      let okAll = true;
      for (const it of items) {
        try {
          let res = await postNote(it.adId, it.note, token);
          if (res.status === 401) {
            // prompt for token once and retry this note
            token = await ensureToken(true);
            if (!token) { okAll = false; break; }
            res = await postNote(it.adId, it.note, token);
          }
          if (!res.ok) { okAll = false; break; }
        } catch {
          okAll = false; break;
        }
      }

      if (okAll) {
        setSyncBtnState(btn, 'Synced ✓', false);
        setTimeout(() => setSyncBtnState(btn, 'Sync notes', false), 1200);
      } else {
        setSyncBtnState(btn, 'Retry sync', false);
      }
    }

    function ensureSyncButton() {
      if (document.getElementById('sahi-sync-notes-btn')) return;
      const btn = document.createElement('button');
      btn.id = 'sahi-sync-notes-btn';
      btn.textContent = 'Sync notes';
      btn.title = 'Sync local notes to server';
      Object.assign(btn.style, {
        position: 'fixed',
        bottom: '16px',
        right: '16px',
        padding: '8px 12px',
        background: '#0069d9',
        color: '#fff',
        border: 'none',
        borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        font: "12px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial",
        zIndex: '2147483647',
        cursor: 'pointer'
      });
      btn.addEventListener('click', () => syncAllNotes(btn));
      document.body.appendChild(btn);
    }

    // ---- Lock/Unlock toggle UI ----
    function ensureLockButton() {
      if (document.getElementById('sahi-lock-toggle-btn')) return;
      const btn = document.createElement('button');
      btn.id = 'sahi-lock-toggle-btn';
      btn.title = 'Lock/unlock Sahi Notes on this page';
      Object.assign(btn.style, {
        position: 'fixed',
        bottom: '56px', // sit just above the Sync button
        right: '16px',
        padding: '0',
        width: '38px',
        height: '38px',
        background: '#6c757d',
        color: '#fff',
        border: 'none',
        borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        font: "12px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial",
        zIndex: '2147483647',
        cursor: 'pointer',
        display: 'grid',
        placeItems: 'center'
      });
      btn.addEventListener('click', () => {
        if (!isPageUnlocked()) {
          const pwd = prompt('Enter password to unlock');
          if (pwd === null) return; // cancelled
          if (pwd === '1234') {
            setPageLocked(false);
            flashLockStatus('Unlocked ✓');
          } else {
            flashLockStatus('Wrong password');
          }
        } else {
          setPageLocked(true);
          flashLockStatus('Locked');
        }
      });
      document.body.appendChild(btn);
      updateLockButtonUI();
    }

    function updateLockButtonUI() {
      const btn = document.getElementById('sahi-lock-toggle-btn');
      if (!btn) return;
      const unlocked = isPageUnlocked();
      // Swap icon (inline SVG) and colors
      const svgLocked = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="#fff" aria-hidden="true">'
        + '<path d="M12 2a5 5 0 00-5 5v3H6a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2v-8a2 2 0 00-2-2h-1V7a5 5 0 00-5-5zm-3 8V7a3 3 0 016 0v3H9zm3 4a2 2 0 110 4 2 2 0 010-4z"/></svg>'
      );
      const svgUnlocked = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="#fff" aria-hidden="true">'
        + '<path d="M17 10h-6V7a3 3 0 116 0h2a5 5 0 10-10 0v3H7a2 2 0 00-2 2v8a2 2 0 002 2h10a2 2 0 002-2v-8a2 2 0 00-2-2zm-5 4a2 2 0 110 4 2 2 0 010-4z"/></svg>'
      );
      btn.innerHTML = unlocked ? svgUnlocked : svgLocked;
      btn.style.background = unlocked ? '#28a745' : '#6c757d';
      btn.setAttribute('aria-pressed', String(unlocked));
      btn.setAttribute('aria-label', unlocked ? 'Page unlocked, click to lock' : 'Page locked, click to unlock');
      btn.title = unlocked ? 'Click to lock this page' : 'Click to unlock this page';
    }

    function flashLockStatus(text) {
      try {
        const el = document.createElement('div');
        el.textContent = text;
        Object.assign(el.style, {
          position: 'fixed',
          bottom: '96px',
          right: '16px',
          background: 'rgba(0,0,0,0.8)',
          color: '#fff',
          padding: '6px 10px',
          borderRadius: '6px',
          font: "12px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial",
          zIndex: '2147483647'
        });
        document.body.appendChild(el);
        setTimeout(() => { try { el.remove(); } catch {} }, 1000);
      } catch {}
    }

    function initialize() {
      try {
        const observer = new MutationObserver((mutations) => {
          let changed = false;
          for (const m of mutations) {
            if (m.type !== 'childList') continue;
            m.addedNodes.forEach(node => {
              if (node.nodeType !== 1) return;
              if (node.matches?.(ROW_SEL)) {
                attachRow(node);
                changed = true;
              } else {
                const rows = node.querySelectorAll?.(ROW_SEL);
                if (rows?.length) {
                  rows.forEach(attachRow);
                  changed = true;
                }
              }
            });
          }
          if (changed) refreshAllStars();
        });

        // Prefer observing the tbody if present
        const tableBody = document.querySelector('#searchResultsTable tbody');
        if (tableBody) {
          observer.observe(tableBody, { childList: true, subtree: true });
          wireAll(tableBody);
          refreshAllStars();
        } else {
          observer.observe(document.body, { childList: true, subtree: true });
          wireAll(document);
          refreshAllStars();
        }

        // One more pass shortly after load to catch late-populated IDs
        setTimeout(refreshAllStars, 600);

        window.addEventListener('unload', () => observer.disconnect(), { passive: true });

        // Add the Sync Notes button once DOM is ready
        ensureSyncButton();
        // Add Lock/Unlock button (locked by default if not set)
        if (!localStorage.getItem(lockKey())) {
          try { localStorage.setItem(lockKey(), 'locked'); } catch {}
        }
        ensureLockButton();
        // If currently unlocked, schedule auto-relock or lock immediately when expired
        scheduleAutoRelock();
      } catch (e) {
        console.error('Error during init:', e);
      }
    }

    function wireAll(root = document) {
      root.querySelectorAll(ROW_SEL).forEach(attachRow);
    }

    function attachRow(row) {
      if (!row || row.__sahiWired) return;
      row.__sahiWired = true;

      const maybeClose = () => {
        if (!row.__sahiRowHover && !row.__sahiBoxHover) {
          try { row.__sahiPosCleanup?.(); } catch (_) {}
          row.__sahiPosCleanup = null;
          try { row.__sahiImgResizeObs?.disconnect?.(); } catch (_) {}
          row.__sahiImgResizeObs = null;
          if (row.__sahiNoteBox?.isConnected) {
            try { row.__sahiNoteBox.remove(); } catch (_) {}
          }
          row.__sahiNoteBox = null;
          row.style.outline = '';
          row.style.outlineOffset = '';
          if (OPEN_ROW === row) OPEN_ROW = null;
        }
      };

      // Show star immediately based on saved note
      refreshRowStar(row);

      row.addEventListener('mouseenter', () => {
        // Close previously open row/box, if any
        if (OPEN_ROW && OPEN_ROW !== row) {
          forceCloseRow(OPEN_ROW);
          OPEN_ROW = null;
        }

        const adId = getAdId(row) || 'unknown';

        row.__sahiRowHover = true;
        row.style.outline = '3px solid red';
        row.style.outlineOffset = '-1px';

        // If already open for this row, just mark as current
        if (row.__sahiNoteBox?.isConnected) {
          OPEN_ROW = row;
          return;
        }

        // Create a floating editable note box to the right of the image cell showing the row id
        const box = document.createElement('div');
        box.className = 'sahi-note-box';
        box.innerHTML = `
          <div style="font-weight:600;margin-bottom:6px">ID: ${adId}</div>
          <textarea placeholder="Enter note..." style="width:100%;height:calc(100% - 24px);border:0;outline:0;resize:none;box-sizing:border-box;font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial;"></textarea>
        `;
        Object.assign(box.style, {
          position: 'fixed',
          top: '0px',
          left: '0px',
          height: '0px',
          width: '0px',
          background: '#fff',
          color: '#000',
          border: '1px solid #ccc',
          borderRadius: '4px',
          padding: '8px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          font: "12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial",
          zIndex: '2147483647',
          pointerEvents: 'auto'
        });
        document.body.appendChild(box);
        row.__sahiNoteBox = box;
        OPEN_ROW = row;

        // Position now and keep in sync with scroll/resize
        const onPos = () => positionNoteBox(row, box);
        onPos();
        window.addEventListener('scroll', onPos, { passive: true });
        window.addEventListener('resize', onPos, { passive: true });

        // Also reposition when the image loads or resizes (lazy-loaded images)
        const firstCell = row.cells?.[0] || row.querySelector('td:first-child') || row;
        const img = firstCell.querySelector?.('img');
        if (img) {
          // ResizeObserver for dimension changes
          if ('ResizeObserver' in window) {
            const ro = new ResizeObserver(() => onPos());
            ro.observe(img);
            row.__sahiImgResizeObs = ro;
          }
          // In case image loads later
          if (!img.complete) {
            const onLoad = () => requestAnimationFrame(onPos);
            img.addEventListener('load', onLoad, { once: true });
          }
        }

        row.__sahiPosCleanup = () => {
          window.removeEventListener('scroll', onPos);
          window.removeEventListener('resize', onPos);
        };

        // Keep open while hovering the box
        box.addEventListener('mouseenter', () => { row.__sahiBoxHover = true; }, { passive: true });
        box.addEventListener('mouseleave', () => {
          row.__sahiBoxHover = false;
          setTimeout(maybeClose, 150);
        }, { passive: true });

        // Load saved note and save on edit (debounced)
        const ta = box.querySelector('textarea');
        ta.value = loadNote(adId);
        ta.addEventListener('input', () => {
          scheduleSave(adId, ta.value);
          // Update star immediately as user types
          if ((ta.value || '').trim()) ensureStar(row);
          else removeStar(row);
        });
      });

      row.addEventListener('mouseleave', () => {
        const adId = getAdId(row) || 'unknown';
        row.__sahiRowHover = false;
        setTimeout(maybeClose, 150);
      });
    }

    // Minimal helper to extract an ad/row id
    function getAdId(row) {
      const fromData = row.getAttribute?.('data-id') || row.dataset?.id;
      if (fromData) return fromData;
      const idAttr = row.getAttribute?.('id');
      if (idAttr) {
        const m = idAttr.match(/\d+/);
        if (m) return m[0];
      }
      const a = row.querySelector?.('a[href*="/ilan/"], a[href*="/detay/"], a[href*="ilan/"]');
      if (a?.href) {
        const m = a.href.match(/\/(\d+)(?:\?|$|\/)/);
        if (m) return m[1];
      }
      return null;
    }

    // ---- Listen for popup command ----
    if (chrome?.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg?.type === 'SAHI_SYNC_NOTES') {
          doSyncNotes().then(sendResponse).catch(() => sendResponse({ ok: false }));
          return true; // async
        }
      });
    }
  } catch (e) {
    console.error('Global error handler:', e);
  }
})();
