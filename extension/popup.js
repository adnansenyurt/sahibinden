document.addEventListener('DOMContentLoaded', async () => {
  const tokenInput = document.getElementById('token');
  const saveBtn = document.getElementById('saveTokenBtn');
  const syncBtn = document.getElementById('syncBtn');
  const status = document.getElementById('status');

  const getLocal = (k) => new Promise(res => chrome.storage.local.get(k, v => res(v?.[k])));
  const setLocal = (obj) => new Promise(res => chrome.storage.local.set(obj, res));

  // Load saved token
  tokenInput.value = (await getLocal('sahi:jwt')) || '';

  saveBtn.addEventListener('click', async () => {
    await setLocal({ 'sahi:jwt': tokenInput.value || '' });
    status.textContent = 'Token saved.';
    setTimeout(() => status.textContent = '', 1000);
  });

  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    status.textContent = 'Syncing…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        status.textContent = 'No active tab.';
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'SAHI_SYNC_NOTES' }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          status.textContent = 'Open a sahibinden.com results page.';
        } else if (resp?.ok) {
          status.textContent = `Synced ✓ (${resp.count || 0})`;
        } else {
          status.textContent = 'Sync failed. Check token/server.';
        }
      });
    } catch {
      status.textContent = 'Sync failed.';
    } finally {
      syncBtn.disabled = false;
    }
  });
});
