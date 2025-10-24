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

    // ---- Key handling: keep Enter inside our textareas (declare early to avoid TDZ) ----
    let __sahiEnterGuardsInstalled = false;
    function ensureGlobalEnterGuards() {
      if (__sahiEnterGuardsInstalled) return;
      const handler = (e) => {
        try {
          const t = e.target;
          if (!(t instanceof Element)) return;
          if (t.closest?.('.sahi-note-wrap') && (e.key === 'Enter' || e.key === 'Return')) {
            e.stopPropagation();
            e.stopImmediatePropagation?.();
          }
        } catch {}
      };
      ['keydown','keypress','keyup'].forEach(type => {
        document.addEventListener(type, handler, true);
      });
      __sahiEnterGuardsInstalled = true;
    }

    function installEnterIsolation(textarea) {
      try {
        if (!textarea) return;
        const onKeyDown = (e) => {
          if ((e.key === 'Enter' || e.key === 'Return') && !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (e.isComposing) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation?.();
            const el = textarea;
            try {
              const start = el.selectionStart ?? el.value.length;
              const end = el.selectionEnd ?? start;
              const scrollTop = el.scrollTop;
              const before = el.value.slice(0, start);
              const after = el.value.slice(end);
              el.value = `${before}\n${after}`;
              const caret = start + 1;
              el.selectionStart = el.selectionEnd = caret;
              el.scrollTop = scrollTop;
              const evt = new Event('input', { bubbles: true });
              el.dispatchEvent(evt);
            } catch {}
          }
        };
        const onKeyOther = (e) => {
          if (e.key === 'Enter' || e.key === 'Return') {
            e.stopPropagation();
            e.stopImmediatePropagation?.();
          }
        };
        textarea.addEventListener('keydown', onKeyDown);
        textarea.addEventListener('keypress', onKeyOther);
        textarea.addEventListener('keyup', onKeyOther);
      } catch {}
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
      initialize();
    }

    let OPEN_ROW = null;

    const SAVE_DEBOUNCE_MS = 300;
    const saveTimers = new Map();
    const savePrivTimers = new Map();
    const noteKey = (id) => `sahi:note:${id}`;
    const privNoteKey = (id) => `sahi:privnote:${id}`;
    function loadNote(adId) {
      try { return localStorage.getItem(noteKey(adId)) || ''; } catch { return ''; }
    }
    function loadPrivNote(adId) {
      try { return localStorage.getItem(privNoteKey(adId)) || ''; } catch { return ''; }
    }
    function scheduleSave(adId, text) {
      clearTimeout(saveTimers.get(adId));
      const t = setTimeout(() => {
        try { localStorage.setItem(noteKey(adId), text || ''); } catch {}
        saveTimers.delete(adId);
      }, SAVE_DEBOUNCE_MS);
      saveTimers.set(adId, t);
    }
    function schedulePrivSave(adId, text) {
      clearTimeout(savePrivTimers.get(adId));
      const t = setTimeout(() => {
        try { localStorage.setItem(privNoteKey(adId), text || ''); } catch {}
        savePrivTimers.delete(adId);
      }, SAVE_DEBOUNCE_MS);
      savePrivTimers.set(adId, t);
    }

    // Helper: compute and apply box position aligned to the image; clamp in viewport
    function positionNoteBox(row, box) {
      const firstCell = row.cells?.[0] || row.querySelector('td:first-child') || row;
      const cellRect = firstCell.getBoundingClientRect ? firstCell.getBoundingClientRect() : row.getBoundingClientRect();
      const img = firstCell.querySelector?.('img');
      const refRect = img?.getBoundingClientRect ? img.getBoundingClientRect() : cellRect;

      const BOX_WIDTH = 220;
      const GAP = 8;
      const minHeight = Math.max(24, refRect.height);
      // Compute total width based on current state (normal + optional toggle + private)
      const TOGGLE_W = isPageUnlocked() && row?.__sahiToggleEl?.isConnected ? 18 : 0;
      const PRIV_W = (isPageUnlocked() && row?.__sahiPrivExpanded) ? BOX_WIDTH : 0;
      let totalWidth = BOX_WIDTH; // normal panel
      if (TOGGLE_W) totalWidth += GAP + TOGGLE_W;
      if (PRIV_W) totalWidth += GAP + PRIV_W;

      // Prefer right of the image; if not enough space, place to the left of the cell
      let left = refRect.right + 8;
      if (left + totalWidth > window.innerWidth - 4) {
        left = Math.max(4, cellRect.left - totalWidth - 8);
      }

      const top = Math.max(4, Math.min(window.innerHeight - minHeight - 4, refRect.top));

      box.style.top = `${top}px`;
      box.style.left = `${left}px`;
      // Let height grow with content; enforce minimum equal to row height
      box.style.minHeight = `${minHeight}px`;
      box.style.height = 'auto';
      box.style.width = `${totalWidth}px`;
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
      row.__sahiPrivExpanded = false;
      row.__sahiPrivStarEl = null;
      row.__sahiToggleEl = null;
      row.style.outline = '';
      row.style.outlineOffset = '';
    }

    // Exposed closer helper for star/box timers
    function tryMaybeClose(row) {
      try { row?.__sahiMaybeClose?.(); } catch {}
    }

    // Helpers to locate title cell for star placement
    function getTitleCell(row) {
      return row.querySelector?.('td.searchResultsTitleValue, .searchResultsTitleValue') || row.cells?.[1] || row.cells?.[0] || row;
    }
    function ensureStarContainer(row) {
      try {
        const titleCell = getTitleCell(row);
        if (!titleCell) return null;
        if (getComputedStyle(titleCell).position === 'static') {
          titleCell.style.position = 'relative';
        }
        if (row.__sahiStarWrap?.isConnected) return row.__sahiStarWrap;
        const wrap = document.createElement('div');
        wrap.className = 'sahi-star-wrap';
        Object.assign(wrap.style, {
          position: 'absolute',
          top: '4px',
          left: '4px',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          zIndex: '2',
          pointerEvents: 'none' // stars re-enable pointer events
        });
        titleCell.appendChild(wrap);
        row.__sahiStarWrap = wrap;
        return wrap;
      } catch { return null; }
    }

    // Small star overlay helpers (normal + private)
    function ensureStar(row) {
      try {
        const wrap = ensureStarContainer(row);
        if (!wrap) return;
        // If star already exists, nothing to do
        if (row.__sahiStarEl?.isConnected) return;

        const star = document.createElement('div');
        star.className = 'sahi-note-star';
        star.textContent = '★';
        Object.assign(star.style, {
          position: 'relative',
          fontSize: '16px',
          lineHeight: '16px',
          color: '#f5c518', // gold-ish
          textShadow: '0 1px 2px rgba(0,0,0,0.35)',
          pointerEvents: 'auto',
          userSelect: 'none',
          cursor: 'pointer'
        });
        wrap.appendChild(star);
        row.__sahiStarEl = star;

        // Hover behavior: show note box when hovering the star
        star.addEventListener('mouseenter', () => {
          row.__sahiStarHover = true;
          openNoteBox(row, false);
        });
        star.addEventListener('mouseleave', () => {
          row.__sahiStarHover = false;
          setTimeout(() => tryMaybeClose(row), 150);
        });
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

    function ensurePrivStar(row) {
      try {
        if (!isPageUnlocked()) { removePrivStar(row); return; }
        const wrap = ensureStarContainer(row);
        if (!wrap) return;
        if (row.__sahiPrivStarEl?.isConnected) return;
        const star = document.createElement('div');
        star.className = 'sahi-priv-star';
        star.textContent = '★';
        Object.assign(star.style, {
          position: 'relative',
          fontSize: '16px',
          lineHeight: '16px',
          color: '#e74c3c', // red
          textShadow: '0 1px 2px rgba(0,0,0,0.35)',
          pointerEvents: 'auto',
          userSelect: 'none',
          cursor: 'pointer'
        });
        wrap.appendChild(star);
        row.__sahiPrivStarEl = star;

        // Hover behavior: show note box with private panel when hovering the red star
        star.addEventListener('mouseenter', () => {
          row.__sahiStarHover = true;
          openNoteBox(row, true);
        });
        star.addEventListener('mouseleave', () => {
          row.__sahiStarHover = false;
          setTimeout(() => tryMaybeClose(row), 150);
        });
      } catch (_) {}
    }

    function removePrivStar(row) {
      try {
        if (row.__sahiPrivStarEl?.isConnected) row.__sahiPrivStarEl.remove();
      } catch (_) {}
      row.__sahiPrivStarEl = null;
    }

    function refreshRowPrivStar(row) {
      const adId = getAdId(row);
      if (!adId) {
        if (!row.__sahiPrivStarRetry) {
          row.__sahiPrivStarRetry = true;
          setTimeout(() => {
            row.__sahiPrivStarRetry = false;
            refreshRowPrivStar(row);
          }, 300);
        }
        removePrivStar(row);
        return;
      }
      if (!isPageUnlocked()) { removePrivStar(row); return; }
      const note = loadPrivNote(adId);
      if ((note || '').trim()) ensurePrivStar(row);
      else removePrivStar(row);
    }

    // New: refresh stars for all current rows
    function refreshAllStars() {
      document.querySelectorAll(ROW_SEL).forEach(row => {
        refreshRowStar(row);
        refreshRowPrivStar(row);
      });
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
          if (!k) continue;
          if (k.startsWith('sahi:note:')) {
            const adId = k.slice('sahi:note:'.length);
            const note = localStorage.getItem(k) || '';
            if ((note || '').trim()) items.push({ adId, note, kind: 'normal' });
          } else if (k.startsWith('sahi:privnote:')) {
            const adId = k.slice('sahi:privnote:'.length);
            const note = localStorage.getItem(k) || '';
            if ((note || '').trim()) items.push({ adId, note, kind: 'private' });
          }
        }
      } catch (_) {}
      return items;
    }
    async function postNote(adId, note, token, kind = 'normal') {
      return fetch(`${SERVER_BASE}/api/notes/${encodeURIComponent(adId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token || ''}`
        },
        mode: 'cors',
        body: JSON.stringify({ note, kind })
      });
    }
    async function doSyncNotes() {
      const items = collectAllNotes();
      if (!items.length) return { ok: true, count: 0 };
      let token = await ensureToken(true);
      if (!token) return { ok: false, error: 'no_token' };

      for (const it of items) {
        try {
          let res = await postNote(it.adId, it.note, token, it.kind);
          if (res.status === 401) {
            token = await ensureToken(true);
            if (!token) return { ok: false, error: 'no_token' };
            res = await postNote(it.adId, it.note, token, it.kind);
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
          let res = await postNote(it.adId, it.note, token, it.kind);
          if (res.status === 401) {
            // prompt for token once and retry this note
            token = await ensureToken(true);
            if (!token) { okAll = false; break; }
            res = await postNote(it.adId, it.note, token, it.kind);
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
      // Update stars/boxes visibility tied to privacy state
      try { refreshAllStars(); } catch {}
      // Extra safety: when locking, force-remove any existing private stars immediately
      if (!unlocked) {
        try { document.querySelectorAll('.sahi-priv-star').forEach(el => el.remove()); } catch {}
      }
      // If an overlay is open, add/remove private panel accordingly
      try {
        if (OPEN_ROW && OPEN_ROW.__sahiNoteBox?.isConnected) {
          updateOpenRowPrivatePanel(OPEN_ROW);
        }
      } catch {}
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
        // Install global key guards once
        ensureGlobalEnterGuards();
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
        if (!row.__sahiStarHover && !row.__sahiBoxHover) {
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
      // expose for star handlers
      row.__sahiMaybeClose = maybeClose;
      function tryMaybeClose(r) { r?.__sahiMaybeClose?.(); }

      // Show star immediately based on saved note
      refreshRowStar(row);

      // NOTE: No row-level hover to open box; stars control it now
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

  // ---- Helpers for private panel in the open overlay ----
    function openNoteBox(row, preferPrivate = false) {
      try {
        // Close previously open row/box, if any
        if (OPEN_ROW && OPEN_ROW !== row) {
          forceCloseRow(OPEN_ROW);
          OPEN_ROW = null;
        }
        const adId = getAdId(row) || 'unknown';

        // If already open for this row, just update state
        if (row.__sahiNoteBox?.isConnected) {
          OPEN_ROW = row;
          if (preferPrivate && isPageUnlocked()) {
            ensureToggleArrow(row);
            if (!row.__sahiPrivPanelEl) addPrivatePanelToBox(row, adId);
            setPrivatePanelExpanded(row, true);
          }
          return;
        }

        // Create a floating wrapper containing the normal and (if unlocked) private note boxes
        const box = document.createElement('div');
        box.className = 'sahi-note-wrap';
        box.innerHTML = `
          <div class="sahi-note-header" style="font-weight:600;margin-bottom:6px">ID: ${adId}</div>
          <div class="sahi-note-panels" style="display:flex;gap:8px;align-items:stretch;">
            <div class="sahi-note-panel" data-type="normal" style="flex:0 0 220px;display:flex;">
              <textarea class="sahi-note-ta" placeholder="Enter note..." style="flex:1;width:100%;height:auto;overflow:hidden;border:0;outline:0;resize:none;box-sizing:border-box;font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial;background:#fff;color:#000;"></textarea>
            </div>
            <!-- toggle and private panel will be injected here -->
          </div>
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
        row.__sahiPrivExpanded = false;

        // Position now and keep in sync with scroll/resize
        const onPos = () => positionNoteBox(row, box);
        onPos();
        window.addEventListener('scroll', onPos, { passive: true });
        window.addEventListener('resize', onPos, { passive: true });

        // Also reposition when the image loads or resizes (lazy-loaded images)
        const firstCell = row.cells?.[0] || row.querySelector('td:first-child') || row;
        const img = firstCell.querySelector?.('img');
        if (img) {
          if ('ResizeObserver' in window) {
            const ro = new ResizeObserver(() => onPos());
            ro.observe(img);
            row.__sahiImgResizeObs = ro;
          }
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
          setTimeout(() => tryMaybeClose(row), 150);
        }, { passive: true });

        // Load saved note and save on edit (debounced)
        const ta = box.querySelector('textarea.sahi-note-ta');
        ta.value = loadNote(adId);
        ta.addEventListener('input', () => {
          scheduleSave(adId, ta.value);
          if ((ta.value || '').trim()) ensureStar(row);
          else removeStar(row);
          autoResizeTextarea(row, ta);
          onPos();
        });
        installEnterIsolation(ta);
        autoResizeTextarea(row, ta);

        // Ensure toggle arrow if unlocked
        updateOpenRowPrivatePanel(row);
        if (preferPrivate && isPageUnlocked()) {
          ensureToggleArrow(row);
          addPrivatePanelToBox(row, adId);
          setPrivatePanelExpanded(row, true);
        }
      } catch {}
    }
    function addPrivatePanelToBox(row, adId) {
      try {
        const wrap = row.__sahiNoteBox;
        if (!wrap?.isConnected) return;
        const panels = wrap.querySelector('.sahi-note-panels');
        if (!panels) return;
        if (panels.querySelector('.sahi-note-panel[data-type="private"]')) return; // already added
        const panel = document.createElement('div');
        panel.className = 'sahi-note-panel';
        panel.setAttribute('data-type', 'private');
        panel.style.flex = '0 0 auto';
        panel.style.display = 'flex';
        panel.style.overflow = 'hidden';
        panel.style.width = '0px';
        panel.style.opacity = '0';
        panel.style.transition = 'width 200ms ease, opacity 200ms ease';
        panel.innerHTML = `
          <textarea class="sahi-priv-ta" placeholder="Enter private note..." style="flex:1;width:100%;height:auto;overflow:hidden;border:0;outline:0;resize:none;box-sizing:border-box;font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial;background:#ffecec;color:#000;"></textarea>
        `;
        panels.appendChild(panel);
        const taPriv = panel.querySelector('textarea.sahi-priv-ta');
        taPriv.value = loadPrivNote(adId);
        taPriv.addEventListener('input', () => {
          schedulePrivSave(adId, taPriv.value);
          if ((taPriv.value || '').trim()) ensurePrivStar(row);
          else removePrivStar(row);
          autoResizeTextarea(row, taPriv);
          try { positionNoteBox(row, row.__sahiNoteBox); } catch {}
        });
        // Isolate Enter key from page handlers
        installEnterIsolation(taPriv);
        // Initial autoresize
        autoResizeTextarea(row, taPriv);
        row.__sahiPrivPanelEl = panel;
      } catch {}
    }

    function removePrivatePanelFromBox(row) {
      try {
        const wrap = row.__sahiNoteBox;
        if (!wrap?.isConnected) return;
        const panel = wrap.querySelector('.sahi-note-panel[data-type="private"]');
        if (panel) panel.remove();
      } catch {}
    }


    function ensureToggleArrow(row) {
      try {
        const wrap = row.__sahiNoteBox;
        if (!wrap?.isConnected) return;
        const panels = wrap.querySelector('.sahi-note-panels');
        if (!panels) return;
        if (row.__sahiToggleEl?.isConnected) return;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'sahi-priv-toggle';
        toggle.textContent = '▶';
        toggle.title = 'Show private note';
        Object.assign(toggle.style, {
          flex: '0 0 18px',
          width: '18px',
          height: '100%',
          border: '1px solid #ddd',
          borderRadius: '4px',
          background: '#f7f7f7',
          color: '#333',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0'
        });
        panels.appendChild(toggle);
        row.__sahiToggleEl = toggle;
        const adId = getAdId(row) || 'unknown';
        toggle.addEventListener('click', () => {
          if (!isPageUnlocked()) return; // ignore when locked
          if (!row.__sahiPrivPanelEl) addPrivatePanelToBox(row, adId);
          const expand = !row.__sahiPrivExpanded;
          setPrivatePanelExpanded(row, expand);
        });
      } catch {}
    }

    function setPrivatePanelExpanded(row, expand) {
      try {
        if (!row?.__sahiNoteBox?.isConnected) return;
        const panel = row.__sahiPrivPanelEl;
        const toggle = row.__sahiToggleEl;
        if (!panel || !toggle) return;
        row.__sahiPrivExpanded = !!expand;
        if (expand) {
          panel.style.width = '220px';
          panel.style.opacity = '1';
          toggle.textContent = '◀';
          toggle.title = 'Hide private note';
          // After expanding, ensure textarea height fits content
          const taPriv = panel.querySelector('textarea.sahi-priv-ta');
          if (taPriv) autoResizeTextarea(row, taPriv);
        } else {
          panel.style.width = '0px';
          panel.style.opacity = '0';
          toggle.textContent = '▶';
          toggle.title = 'Show private note';
        }
        // Reposition after transition
        const box = row.__sahiNoteBox;
        const onEnd = () => { try { positionNoteBox(row, box); } catch {} panel.removeEventListener('transitionend', onEnd); };
        panel.addEventListener('transitionend', onEnd);
        // Also update immediately for responsiveness
        try { positionNoteBox(row, box); } catch {}
      } catch {}
    }

    function ensureToggleHidden(row) {
      try {
        if (row.__sahiToggleEl?.isConnected) { row.__sahiToggleEl.remove(); }
        row.__sahiToggleEl = null;
      } catch {}
    }

    function updateOpenRowPrivatePanel(row) {
      if (!row?.__sahiNoteBox?.isConnected) return;
      const adId = getAdId(row) || 'unknown';
      if (isPageUnlocked()) {
        // Show/ensure toggle; private panel starts collapsed
        ensureToggleArrow(row);
        if (row.__sahiPrivPanelEl && !row.__sahiPrivExpanded) {
          // keep collapsed; no action
        }
      } else {
        // Hide toggle and private panel
        row.__sahiPrivExpanded = false;
        if (row.__sahiPrivPanelEl) {
          row.__sahiPrivPanelEl.style.width = '0px';
          row.__sahiPrivPanelEl.style.opacity = '0';
        }
        ensureToggleHidden(row);
      }
      try { positionNoteBox(row, row.__sahiNoteBox); } catch {}
    }

    // Auto-resize textareas to fit content, enforce minimum box height via positionNoteBox
    function autoResizeTextarea(row, textarea) {
      try {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
      } catch {}
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
