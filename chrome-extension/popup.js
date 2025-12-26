// Minimal popup controller to trigger scraping and send result to remote API

const DEFAULT_BASE_URL = (self.EMLAK_CONFIG?.DEFAULT_EMLAK_BASE_URL) || 'http://localhost:8084';
const RESOLVE_BASE_URL = self.EMLAK_CONFIG?.resolveEmlakBaseUrl || ((v) => (v || DEFAULT_BASE_URL).replace(/\/$/, ''));
const AUTH_PATHS = ['/api/custom/authenticate', '/api/authenticate'];

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || {};
}

function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg || '';
}

function setOutput(obj) {
  const pre = document.getElementById('out');
  if (pre) pre.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}

const getLocal = (k) => new Promise((res) => chrome.storage.local.get(k, (v) => res(v?.[k])));
const setLocal = (obj) => new Promise((res) => chrome.storage.local.set(obj, res));

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('scrape');
  const baseUrlInput = document.getElementById('emlakBaseUrl');
  const loginView = document.getElementById('loginView');
  const loggedInView = document.getElementById('loggedInView');
  const loggedInEmailEl = document.getElementById('loggedInEmail');
  const loginEmail = document.getElementById('loginEmail');
  const loginPassword = document.getElementById('loginPassword');
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const ilanNoRow = document.getElementById('ilanNoRow');
  const ilanNoVal = document.getElementById('ilanNoVal');
  const notesSection = document.getElementById('notesSection');
  const notesList = document.getElementById('notesList');
  const addNoteToggle = document.getElementById('addNoteToggle');
  const addNoteForm = document.getElementById('addNoteForm');
  const noteText = document.getElementById('noteText');
  const notePrivate = document.getElementById('notePrivate');
  const submitNoteBtn = document.getElementById('submitNoteBtn');
  const noteErr = document.getElementById('noteErr');
  const geminiKeyToggle = document.getElementById('geminiKeyToggle');
  const geminiKeyForm = document.getElementById('geminiKeyForm');
  const geminiKeyInput = document.getElementById('geminiKeyInput');
  const saveGeminiKeyBtn = document.getElementById('saveGeminiKeyBtn');
  const testGeminiKeyBtn = document.getElementById('testGeminiKeyBtn');
  const geminiKeyStatus = document.getElementById('geminiKeyStatus');

  let lastScrape = null;

  // Listen for background progress messages (image upload flow)
  chrome.runtime.onMessage.addListener((message) => {
    try {
      if (!message || !message.action) return;
      if (message.action === 'imageImportStart') {
        const total = message.total || 0;
        setStatus(total > 0 ? `Görsel aktarımı: 0/${total}` : 'Görsel aktarımı başlatılıyor...');
      } else if (message.action === 'imageImportProgress') {
        const total = message.total || 0;
        const imported = message.imported || 0;
        setStatus(`Görsel aktarımı: ${imported}/${total}`);
      } else if (message.action === 'imageImportDone') {
        const total = message.total || 0;
        const imported = message.imported || 0;
        setStatus(`Görsel aktarımı tamamlandı: ${imported}/${total}`);
      } else if (message.action === 'syncStatus') {
        // Initialization sync after page load/login
        try {
          if (message.ilanNo && ilanNoVal) ilanNoVal.textContent = message.ilanNo;
          if (ilanNoRow) ilanNoRow.style.display = message.ilanNo ? 'block' : 'none';
          if (Array.isArray(message.notes)) {
            renderNotes(message.notes);
          }
          setStatus(message.ok ? 'Senkronizasyon tamamlandı.' : 'Senkronizasyon başarısız.');
          setTimeout(() => setStatus(''), 1200);
        } catch (_) {}
      } else if (message.action === 'apiDebug') {
        try {
          appendApiLog(message);
        } catch(_) {}
      }
    } catch (_) {}
  });

  // Load base URL
  (async () => {
    const saved = await getLocal('sahi:emlakUrl');
    baseUrlInput && (baseUrlInput.value = saved ? RESOLVE_BASE_URL(saved) : DEFAULT_BASE_URL);
  })();
  baseUrlInput?.addEventListener('change', async () => {
    const val = (baseUrlInput.value || '').trim();
    await setLocal({ 'sahi:emlakUrl': RESOLVE_BASE_URL(val) });
  });

  // Load and display Gemini API key status
  (async () => {
    const savedKey = await getLocal('sahi:geminiKey');
    if (savedKey) {
      geminiKeyInput.value = savedKey;
      geminiKeyStatus.textContent = 'API anahtarı kayıtlı.';
      geminiKeyStatus.style.color = '#28a745';
    }
  })();

  // Gemini API key toggle
  geminiKeyToggle?.addEventListener('click', () => {
    const isVisible = geminiKeyForm.style.display !== 'none';
    geminiKeyForm.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
      geminiKeyInput.focus();
    }
  });

  // Save Gemini API key
  saveGeminiKeyBtn?.addEventListener('click', async () => {
    const key = (geminiKeyInput.value || '').trim();
    if (!key) {
      geminiKeyStatus.textContent = 'API anahtarı boş olamaz.';
      geminiKeyStatus.style.color = '#dc3545';
      return;
    }
    await setLocal({ 'sahi:geminiKey': key });
    geminiKeyStatus.textContent = 'API anahtarı kaydedildi.';
    geminiKeyStatus.style.color = '#28a745';
    setTimeout(() => {
      geminiKeyForm.style.display = 'none';
    }, 1500);
  });

  // Test Gemini API key
  testGeminiKeyBtn?.addEventListener('click', async () => {
    const key = (geminiKeyInput.value || '').trim();
    if (!key) {
      geminiKeyStatus.textContent = 'API anahtarı boş olamaz.';
      geminiKeyStatus.style.color = '#dc3545';
      return;
    }
    geminiKeyStatus.textContent = 'Test ediliyor...';
    geminiKeyStatus.style.color = '#007bff';

    try {
      // Send test request to background script
      const response = await chrome.runtime.sendMessage({
        type: 'testGeminiKey',
        apiKey: key
      });

      if (response && response.ok) {
        geminiKeyStatus.textContent = 'API anahtarı geçerli.';
        geminiKeyStatus.style.color = '#28a745';
      } else {
        geminiKeyStatus.textContent = 'API anahtarı geçersiz: ' + (response?.message || 'Bilinmeyen hata');
        geminiKeyStatus.style.color = '#dc3545';
      }
    } catch (error) {
      geminiKeyStatus.textContent = 'Test başarısız: ' + (error?.message || error);
      geminiKeyStatus.style.color = '#dc3545';
    }
  });

  // Auth view helpers
  const showLogin = () => {
    if (loginView) loginView.style.display = 'block';
    if (loggedInView) loggedInView.style.display = 'none';
  };
  const showLoggedIn = (email) => {
    if (loginView) loginView.style.display = 'none';
    if (loggedInView) loggedInView.style.display = 'flex';
    if (loggedInEmailEl) loggedInEmailEl.textContent = email ? `Giriş yapıldı: ${email}` : 'Giriş yapıldı';
  };

  (async () => {
    const [jwt, email] = await Promise.all([getLocal('sahi:jwt'), getLocal('sahi:userEmail')]);
    if (jwt) showLoggedIn(email || ''); else showLogin();
  })();

  // Show İlan No for current tab if available from background cache
  (async () => {
    try {
      const tab = await getActiveTab();
      const info = await chrome.runtime.sendMessage({ type: 'getCurrentInfo', tabId: tab?.id });
      if (info && info.ok && (info.ilanNo || info.sourceId)) {
        if (ilanNoVal) ilanNoVal.textContent = info.ilanNo || info.sourceId || '-';
        if (ilanNoRow) ilanNoRow.style.display = 'block';
        // Always show notes section so user can add a note even if sync fails or returns empty
        try { renderNotes([]); } catch (_) { if (notesSection) notesSection.style.display = 'block'; }
        // Load notes for this property
        try {
          const sync = await chrome.runtime.sendMessage({ type: 'getSyncData', sourceId: info.sourceId });
          if (sync && sync.ok) {
            renderNotes(sync.notes || []);
          } // if sync fails, keep the empty placeholder and visible add button
        } catch (_) {}
      } else {
        if (ilanNoRow) ilanNoRow.style.display = 'none';
      }
    } catch (_) {
      if (ilanNoRow) ilanNoRow.style.display = 'none';
    }
  })();

  function renderNotes(notes) {
    try {
      const arr = Array.isArray(notes) ? notes : [];
      if (notesSection) notesSection.style.display = 'block';
      if (!notesList) return;
      if (!arr.length) {
        notesList.innerHTML = '<div style="color:#666;">Not yok.</div>';
        return;
      }
      const html = arr.map(n => {
        const id = (n && n.id) ? String(n.id) : '';
        const typeRaw = (n && n.type) ? String(n.type) : 'PUBLIC';
        const type = String(typeRaw).toUpperCase() === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC';
        const dt = (n && n.lastUpdate) ? String(n.lastUpdate) : '';
        const text = (n && n.text) ? String(n.text) : '';
        const badge = type === 'PRIVATE'
          ? '<span style="background:#b00020;color:#fff;border-radius:3px;padding:0 4px;margin-right:6px;">PRIVATE</span>'
          : '<span style="background:#0b79ff;color:#fff;border-radius:3px;padding:0 4px;margin-right:6px;">PUBLIC</span>';
        const when = dt ? new Date(dt).toLocaleString() : '';
        return `<div style="padding:6px; border:1px solid #eee; border-radius:4px; margin-bottom:6px;">
          <div style="font-size:11px; color:#444; margin-bottom:4px; display:flex; gap:6px; align-items:center;">
            ${badge}
            ${when ? `<span title="${dt}">${when}</span>` : ''}
            ${id ? `<span style="margin-left:auto; color:#aaa;">#${id}</span>` : ''}
          </div>
          <div style="white-space:pre-wrap;">${escapeHtml(text)}</div>
        </div>`;
      }).join('');
      notesList.innerHTML = html;
    } catch (_) {}
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- API debug log rendering ---
  const apiLogs = [];
  function appendApiLog(msg) {
    const now = new Date();
    const ts = now.toLocaleTimeString();
    const entry = {
      t: ts,
      m: msg.method || '',
      u: msg.url || '',
      s: typeof msg.status === 'undefined' ? '' : msg.status,
      e: msg.error || '',
      b: msg.body || msg.note || ''
    };
    apiLogs.push(entry);
    // Keep only last 50 entries
    if (apiLogs.length > 50) apiLogs.splice(0, apiLogs.length - 50);
    renderApiLogs();
  }

  function renderApiLogs() {
    const pre = document.getElementById('out');
    if (!pre) return;
    const lines = apiLogs.map(x => {
      const head = `[${x.t}] ${x.m} ${x.u} -> ${x.s || ''}`;
      const body = x.e ? `ERROR: ${x.e}` : (x.b || '');
      return head + (body ? `\n${body}` : '');
    });
    pre.textContent = lines.join('\n\n');
  }

  addNoteToggle?.addEventListener('click', () => {
    if (!addNoteForm) return;
    const vis = addNoteForm.style.display !== 'none';
    addNoteForm.style.display = vis ? 'none' : 'block';
    noteErr && (noteErr.textContent = '');
  });

  submitNoteBtn?.addEventListener('click', async () => {
    try {
      if (noteErr) noteErr.textContent = '';
      if (submitNoteBtn) submitNoteBtn.disabled = true;
      const tab = await getActiveTab();
      const info = await chrome.runtime.sendMessage({ type: 'getCurrentInfo', tabId: tab?.id });
      const sourceId = info?.sourceId || '';
      const text = (noteText?.value || '').trim();
      const type = notePrivate?.checked ? 'PRIVATE' : 'PUBLIC';
      if (!sourceId) {
        if (noteErr) noteErr.textContent = 'İlan numarası bulunamadı.';
        return;
      }
      if (!text) {
        if (noteErr) noteErr.textContent = 'Not metni gerekli.';
        return;
      }
      setStatus('Not gönderiliyor…');
      const res = await chrome.runtime.sendMessage({ type: 'addNote', sourceId, text, noteType: type });
      if (!res || !res.ok) {
        if (noteErr) noteErr.textContent = res?.error || 'Gönderim başarısız';
        setStatus('Not gönderimi başarısız.');
        return;
      }
      renderNotes(res.notes || []);
      setStatus('Not eklendi.');
      if (noteText) noteText.value = '';
      if (notePrivate) notePrivate.checked = false;
      if (addNoteForm) addNoteForm.style.display = 'none';
      setTimeout(() => setStatus(''), 1000);
    } catch (e) {
      if (noteErr) noteErr.textContent = String(e && e.message ? e.message : e);
    } finally {
      if (submitNoteBtn) submitNoteBtn.disabled = false;
    }
  });

  async function doLogin() {
    const email = (loginEmail?.value || '').trim();
    const password = (loginPassword?.value || '').trim();
    if (!email || !password) {
      setStatus('E-posta ve şifre gerekli.');
      return;
    }
    try {
      if (loginBtn) loginBtn.disabled = true;
      setStatus('Giriş yapılıyor…');
      const base = RESOLVE_BASE_URL((baseUrlInput?.value || '').trim() || (await getLocal('sahi:emlakUrl')) || DEFAULT_BASE_URL);
      const baseClean = base;
      // Delegate login to background to avoid CORS from popup
      const res = await chrome.runtime.sendMessage({ type: 'emlakLogin', email, password, baseUrl: baseClean });
      if (!res?.ok || !res.token) throw new Error(res?.error || 'Kimlik doğrulama başarısız.');

      await setLocal({ 'sahi:jwt': res.token, 'sahi:userEmail': email, 'sahi:emlakUrl': baseClean });
      showLoggedIn(email);
      setStatus('Giriş başarılı.');
      setTimeout(() => setStatus(''), 1200);
      // Trigger an initialization sync for the current tab now that we have a token
      try {
        const tab = await getActiveTab();
        const url = tab?.url || '';
        if (url && /^https:\/\/([^./]+\.)*sahibinden\.com\/ilan\//.test(url)) {
          await chrome.runtime.sendMessage({ type: 'initSyncForCurrent', tabId: tab.id, url });
        }
      } catch (_) {}
    } catch (e) {
      setStatus('Giriş başarısız: ' + (e?.message || e));
    } finally {
      if (loginBtn) loginBtn.disabled = false;
    }
  }

  loginBtn?.addEventListener('click', doLogin);
  loginPassword?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  logoutBtn?.addEventListener('click', async () => {
    await setLocal({ 'sahi:jwt': '', 'sahi:userEmail': '' });
    showLogin();
    setStatus('Çıkış yapıldı.');
    setTimeout(() => setStatus(''), 1000);
  });

  function noop() {}

  btn?.addEventListener('click', async () => {
    setStatus('Çözümleme yapılıyor...');
    setOutput('');
    lastScrape = null;
    noop();
    const tab = await getActiveTab();
    const url = tab?.url || '';
    const tabId = tab?.id;
    const isDetail = /^https:\/\/([^./]+\.)*sahibinden\.com\/ilan\//.test(url || '');
    if (!isDetail) {
      setStatus('Bu sayfa sahibi̇nden i̇lan detay sayfası değil.');
      return;
    }
    try {
      const result = await chrome.runtime.sendMessage({ type: 'scrapeCurrent', url, tabId });
      lastScrape = result;
      if (result?.success) {
        setStatus('Tamamlandı');
        setOutput(result.data);
        // Update İlan No display after manual scrape
        try {
          const info = await chrome.runtime.sendMessage({ type: 'getCurrentInfo', tabId });
          if (info && info.ok && (info.ilanNo || info.sourceId)) {
            if (ilanNoVal) ilanNoVal.textContent = info.ilanNo || info.sourceId || '-';
            if (ilanNoRow) ilanNoRow.style.display = 'block';
          }
        } catch (_) {}
      } else {
        setStatus(result?.error || 'Bilinmeyen hata');
        setOutput(result);
      }
    } catch (e) {
      lastScrape = null;
      setStatus('Hata: ' + (e?.message || e));
  } finally {
      // no-op
  }
  });

  // Listen for auto-send events from background to update UI
  chrome.runtime.onMessage.addListener((message) => {
    try {
      if (message?.action === 'autoSendStart') {
        setStatus('API\'ye otomatik gönderiliyor…');
      } else if (message?.action === 'autoSendDone') {
        if (message.ok) setStatus('API gönderimi başarılı.');
        else setStatus('API gönderimi başarısız: ' + (message.error || 'Bilinmeyen hata'));
      }
    } catch (_) {}
  });
});
