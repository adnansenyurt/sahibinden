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

    function initialize() {
      try {
        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type !== 'childList') continue;
            m.addedNodes.forEach(node => {
              if (node.nodeType !== 1) return;
              if (node.matches?.(ROW_SEL)) {
                attachRow(node);
              } else {
                node.querySelectorAll?.(ROW_SEL)?.forEach(attachRow);
              }
            });
          }
        });

        // Prefer observing the tbody if available
        const tableBody = document.querySelector('#searchResultsTable tbody');
        if (tableBody) {
          observer.observe(tableBody, { childList: true, subtree: true });
          wireAll(tableBody);
        } else {
          observer.observe(document.body, { childList: true, subtree: true });
          wireAll(document);
        }

        window.addEventListener('unload', () => observer.disconnect(), { passive: true });
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
        ta.addEventListener('input', () => scheduleSave(adId, ta.value));
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
  } catch (e) {
    console.error('Global error handler:', e);
  }
})();
