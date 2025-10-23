(() => {
  try {
    console.log('[sahi] content script boot', location.href);

    // Allow only sahibinden.com and its subdomains
    const host = location.hostname;
    const isAllowedHost = host === 'sahibinden.com' || host.endsWith('.sahibinden.com');
    if (!isAllowedHost) {
      console.log(`[sahi] not allowed host: ${host}`);
      return;
    }

    // Prevent duplicate initialization
    const EXTENSION_ID = 'sahi-hover-logger';
    if (window[EXTENSION_ID]) return;
    window[EXTENSION_ID] = true;

    const ROW_SEL = '#searchResultsTable tbody tr.searchResultsItem';

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
      initialize();
    }

    // Track a single open row/box globally
    let OPEN_ROW = null;

    // Helper to force-close a row's note box and clear styles
    function forceCloseRow(row) {
      if (!row) return;
      const prevId = getAdId(row) || 'unknown';
      console.log('[sahi] force close previous row', prevId);
      row.__sahiRowHover = false;
      row.__sahiBoxHover = false;
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
        console.log('[sahi] init complete');
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
        console.log('[sahi] row enter', adId);

        row.__sahiRowHover = true;
        row.style.outline = '3px solid red';
        row.style.outlineOffset = '-1px';

        // If already open for this row, just mark as current
        if (row.__sahiNoteBox?.isConnected) {
          OPEN_ROW = row;
          return;
        }

        // Create a floating editable note box to the right of the image cell showing the row id
        const firstCell = row.cells?.[0] || row.querySelector('td:first-child') || row;
        const rect = firstCell.getBoundingClientRect ? firstCell.getBoundingClientRect() : row.getBoundingClientRect();

        const box = document.createElement('div');
        box.className = 'sahi-note-box';
        box.innerHTML = `
          <div style="font-weight:600;margin-bottom:6px">ID: ${adId}</div>
          <textarea placeholder="Enter note..." style="width:100%;height:calc(100% - 24px);border:0;outline:0;resize:none;box-sizing:border-box;font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial;"></textarea>
        `;
        Object.assign(box.style, {
          position: 'fixed',
          top: `${rect.top}px`,
          left: `${rect.right + 8}px`,
          height: `${rect.height}px`,
          minWidth: '160px',
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

        // Keep open while hovering the box
        box.addEventListener('mouseenter', () => { row.__sahiBoxHover = true; }, { passive: true });
        box.addEventListener('mouseleave', () => {
          row.__sahiBoxHover = false;
          setTimeout(maybeClose, 150);
        }, { passive: true });
      });

      row.addEventListener('mouseleave', () => {
        const adId = getAdId(row) || 'unknown';
        console.log('[sahi] row leave', adId);
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
