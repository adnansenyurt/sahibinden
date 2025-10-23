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

      row.addEventListener('mouseenter', () => {
        console.log('[sahi] row enter');
        row.style.outline = '3px solid red';
        row.style.outlineOffset = '-1px';

        // Create a floating note box to the right of the image cell showing the row id
        const adId = getAdId(row) || 'unknown';
        const firstCell = row.cells?.[0] || row.querySelector('td:first-child') || row;
        const rect = firstCell.getBoundingClientRect ? firstCell.getBoundingClientRect() : row.getBoundingClientRect();

        const box = document.createElement('div');
        box.className = 'sahi-note-box';
        box.textContent = `ID: ${adId}`;
        Object.assign(box.style, {
          position: 'fixed',
          top: `${rect.top}px`,
          left: `${rect.right + 8}px`,
          height: `${rect.height}px`,
          minWidth: '120px',
          background: '#fff',
          color: '#000',
          border: '1px solid #ccc',
          borderRadius: '4px',
          padding: '8px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          font: "12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial",
          zIndex: '2147483647',
          pointerEvents: 'none'
        });
        document.body.appendChild(box);
        row.__sahiNoteBox = box;
      });

      row.addEventListener('mouseleave', () => {
        console.log('[sahi] row leave');
        row.style.outline = '';
        row.style.outlineOffset = '';

        if (row.__sahiNoteBox && row.__sahiNoteBox.isConnected) {
          try { row.__sahiNoteBox.remove(); } catch (_) {}
        }
        row.__sahiNoteBox = null;
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
