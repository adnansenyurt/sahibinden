// Minimal popup controller to trigger scraping and send result to remote API

const { DEFAULT_EMLAK_BASE_URL: DEFAULT_BASE_URL, resolveEmlakBaseUrl: RESOLVE_BASE_URL } = (() => {
  if (!self.EMLAK_CONFIG?.DEFAULT_EMLAK_BASE_URL || typeof self.EMLAK_CONFIG?.resolveEmlakBaseUrl !== 'function') {
    throw new Error('EmlakConfig is required and must define DEFAULT_EMLAK_BASE_URL and resolveEmlakBaseUrl');
  }
  return self.EMLAK_CONFIG;
})();
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
  const els = {
    btn: document.getElementById('scrape'),
    baseUrlInput: document.getElementById('emlakBaseUrl'),
    loginView: document.getElementById('loginView'),
    loggedInView: document.getElementById('loggedInView'),
    loggedInEmailEl: document.getElementById('loggedInEmail'),
    loginEmail: document.getElementById('loginEmail'),
    loginPassword: document.getElementById('loginPassword'),
    loginBtn: document.getElementById('loginBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    ilanNoRow: document.getElementById('ilanNoRow'),
    ilanNoVal: document.getElementById('ilanNoVal'),
    notesSection: document.getElementById('notesSection'),
    notesList: document.getElementById('notesList'),
    addNoteToggle: document.getElementById('addNoteToggle'),
    addNoteForm: document.getElementById('addNoteForm'),
    noteText: document.getElementById('noteText'),
    notePrivate: document.getElementById('notePrivate'),
    submitNoteBtn: document.getElementById('submitNoteBtn'),
    noteErr: document.getElementById('noteErr'),
    geminiKeyToggle: document.getElementById('geminiKeyToggle'),
    geminiKeyForm: document.getElementById('geminiKeyForm'),
    geminiKeyInput: document.getElementById('geminiKeyInput'),
    saveGeminiKeyBtn: document.getElementById('saveGeminiKeyBtn'),
    testGeminiKeyBtn: document.getElementById('testGeminiKeyBtn'),
    geminiKeyStatus: document.getElementById('geminiKeyStatus'),
    out: document.getElementById('out'),
    status: document.getElementById('status')
  };

  const state = {
    lastScrape: null,
    apiLogs: []
  };

  const ui = {
    showLogin() {
      if (els.loginView) els.loginView.style.display = 'block';
      if (els.loggedInView) els.loggedInView.style.display = 'none';
    },
    showLoggedIn(email) {
      if (els.loginView) els.loginView.style.display = 'none';
      if (els.loggedInView) els.loggedInView.style.display = 'flex';
      if (els.loggedInEmailEl) els.loggedInEmailEl.textContent = email ? `Giriş yapıldı: ${email}` : 'Giriş yapıldı';
    },
    showStatus(msg, clearAfterMs) {
      setStatus(msg);
      if (clearAfterMs) setTimeout(() => setStatus(''), clearAfterMs);
    },
    setOutput(obj) {
      setOutput(obj);
    }
  };

  const messageHandlers = {
    imageImportStart(message) {
      const total = message.total || 0;
      setStatus(total > 0 ? `Görsel aktarımı: 0/${total}` : 'Görsel aktarımı başlatılıyor...');
    },
    imageImportProgress(message) {
      const total = message.total || 0;
      const imported = message.imported || 0;
      setStatus(`Görsel aktarımı: ${imported}/${total}`);
    },
    imageImportDone(message) {
      const total = message.total || 0;
      const imported = message.imported || 0;
      setStatus(`Görsel aktarımı tamamlandı: ${imported}/${total}`);
    },
    syncStatus(message) {
      try {
        if (message.ilanNo && els.ilanNoVal) els.ilanNoVal.textContent = message.ilanNo;
        if (els.ilanNoRow) els.ilanNoRow.style.display = message.ilanNo ? 'block' : 'none';
        if (Array.isArray(message.notes)) {
          renderNotes(message.notes);
        }
        setStatus(message.ok ? 'Senkronizasyon tamamlandı.' : 'Senkronizasyon başarısız.');
        setTimeout(() => setStatus(''), 1200);
      } catch (_) {}
    },
    apiDebug(message) {
      appendApiLog(message);
    },
    autoSendStart() {
      setStatus("API'ye otomatik gönderiliyor…");
    },
    autoSendDone(message) {
      if (message.ok) setStatus('API gönderimi başarılı.');
      else setStatus('API gönderimi başarısız: ' + (message.error || 'Bilinmeyen hata'));
    }
  };

  chrome.runtime.onMessage.addListener((message) => {
    try {
      if (!message || !message.action) return;
      const handler = messageHandlers[message.action];
      if (typeof handler === 'function') handler(message);
    } catch (_) {}
  });

  initBaseUrl();
  initGeminiKey();
  initAuthView();
  initCurrentInfo();
  bindGeminiKeyActions();
  bindNoteActions();
  bindAuthActions();
  bindScrapeButton();

  function initBaseUrl() {
    (async () => {
      const saved = await getLocal('sahi:emlakUrl');
      if (els.baseUrlInput) {
        els.baseUrlInput.placeholder = DEFAULT_BASE_URL;
        els.baseUrlInput.value = saved ? RESOLVE_BASE_URL(saved) : DEFAULT_BASE_URL;
      }
    })();
    els.baseUrlInput?.addEventListener('change', async () => {
      const val = (els.baseUrlInput.value || '').trim();
      await setLocal({ 'sahi:emlakUrl': RESOLVE_BASE_URL(val) });
    });
  }

  function initGeminiKey() {
    (async () => {
      const savedKey = await getLocal('sahi:geminiKey');
      if (savedKey) {
        if (els.geminiKeyInput) els.geminiKeyInput.value = savedKey;
        updateGeminiStatus('API anahtarı kayıtlı.', '#28a745');
      }
    })();
  }

  function updateGeminiStatus(text, color) {
    if (!els.geminiKeyStatus) return;
    els.geminiKeyStatus.textContent = text;
    if (color) els.geminiKeyStatus.style.color = color;
  }

  function bindGeminiKeyActions() {
    els.geminiKeyToggle?.addEventListener('click', () => {
      if (!els.geminiKeyForm) return;
      const isVisible = els.geminiKeyForm.style.display !== 'none';
      els.geminiKeyForm.style.display = isVisible ? 'none' : 'block';
      if (!isVisible) {
        els.geminiKeyInput?.focus();
      }
    });

    els.saveGeminiKeyBtn?.addEventListener('click', async () => {
      const key = (els.geminiKeyInput?.value || '').trim();
      if (!key) {
        updateGeminiStatus('API anahtarı boş olamaz.', '#dc3545');
        return;
      }
      await setLocal({ 'sahi:geminiKey': key });
      updateGeminiStatus('API anahtarı kaydedildi.', '#28a745');
      setTimeout(() => {
        if (els.geminiKeyForm) els.geminiKeyForm.style.display = 'none';
      }, 1500);
    });

    els.testGeminiKeyBtn?.addEventListener('click', async () => {
      const key = (els.geminiKeyInput?.value || '').trim();
      if (!key) {
        updateGeminiStatus('API anahtarı boş olamaz.', '#dc3545');
        return;
      }
      updateGeminiStatus('Test ediliyor...', '#007bff');
      try {
        const response = await chrome.runtime.sendMessage({ type: 'testGeminiKey', apiKey: key });
        if (response && response.ok) {
          updateGeminiStatus('API anahtarı geçerli.', '#28a745');
        } else {
          updateGeminiStatus('API anahtarı geçersiz: ' + (response?.message || 'Bilinmeyen hata'), '#dc3545');
        }
      } catch (error) {
        updateGeminiStatus('Test başarısız: ' + (error?.message || error), '#dc3545');
      }
    });
  }

  function initAuthView() {
    (async () => {
      const [jwt, email] = await Promise.all([getLocal('sahi:jwt'), getLocal('sahi:userEmail')]);
      if (jwt) ui.showLoggedIn(email || ''); else ui.showLogin();
    })();
  }

  function initCurrentInfo() {
    (async () => {
      try {
        const tab = await getActiveTab();
        const info = await chrome.runtime.sendMessage({ type: 'getCurrentInfo', tabId: tab?.id });
        if (info && info.ok && (info.ilanNo || info.sourceId)) {
          if (els.ilanNoVal) els.ilanNoVal.textContent = info.ilanNo || info.sourceId || '-';
          if (els.ilanNoRow) els.ilanNoRow.style.display = 'block';
          try { renderNotes([]); } catch (_) { if (els.notesSection) els.notesSection.style.display = 'block'; }
          try {
            const sync = await chrome.runtime.sendMessage({ type: 'getSyncData', sourceId: info.sourceId });
            if (sync && sync.ok) {
              renderNotes(sync.notes || []);
            }
          } catch (_) {}
        } else {
          if (els.ilanNoRow) els.ilanNoRow.style.display = 'none';
        }
      } catch (_) {
        if (els.ilanNoRow) els.ilanNoRow.style.display = 'none';
      }
    })();
  }

  function bindNoteActions() {
    els.addNoteToggle?.addEventListener('click', () => {
      if (!els.addNoteForm) return;
      const vis = els.addNoteForm.style.display !== 'none';
      els.addNoteForm.style.display = vis ? 'none' : 'block';
      if (els.noteErr) els.noteErr.textContent = '';
    });

    els.submitNoteBtn?.addEventListener('click', async () => {
      try {
        if (els.noteErr) els.noteErr.textContent = '';
        if (els.submitNoteBtn) els.submitNoteBtn.disabled = true;
        const tab = await getActiveTab();
        const info = await chrome.runtime.sendMessage({ type: 'getCurrentInfo', tabId: tab?.id });
        const sourceId = info?.sourceId || '';
        const text = (els.noteText?.value || '').trim();
        const type = els.notePrivate?.checked ? 'PRIVATE' : 'PUBLIC';
        if (!sourceId) {
          if (els.noteErr) els.noteErr.textContent = 'İlan numarası bulunamadı.';
          return;
        }
        if (!text) {
          if (els.noteErr) els.noteErr.textContent = 'Not metni gerekli.';
          return;
        }
        setStatus('Not gönderiliyor…');
        const res = await chrome.runtime.sendMessage({ type: 'addNote', sourceId, text, noteType: type });
        if (!res || !res.ok) {
          if (els.noteErr) els.noteErr.textContent = res?.error || 'Gönderim başarısız';
          setStatus('Not gönderimi başarısız.');
          return;
        }
        renderNotes(res.notes || []);
        setStatus('Not eklendi.');
        if (els.noteText) els.noteText.value = '';
        if (els.notePrivate) els.notePrivate.checked = false;
        if (els.addNoteForm) els.addNoteForm.style.display = 'none';
        setTimeout(() => setStatus(''), 1000);
      } catch (e) {
        if (els.noteErr) els.noteErr.textContent = String(e && e.message ? e.message : e);
      } finally {
        if (els.submitNoteBtn) els.submitNoteBtn.disabled = false;
      }
    });
  }

  function bindAuthActions() {
    const doLogin = async () => {
      const email = (els.loginEmail?.value || '').trim();
      const password = (els.loginPassword?.value || '').trim();
      if (!email || !password) {
        setStatus('E-posta ve şifre gerekli.');
        return;
      }
      try {
        if (els.loginBtn) els.loginBtn.disabled = true;
        setStatus('Giriş yapılıyor…');
        const base = RESOLVE_BASE_URL((els.baseUrlInput?.value || '').trim() || (await getLocal('sahi:emlakUrl')) || DEFAULT_BASE_URL);
        const res = await chrome.runtime.sendMessage({ type: 'emlakLogin', email, password, baseUrl: base });
        if (!res?.ok || !res.token) throw new Error(res?.error || 'Kimlik doğrulama başarısız.');

        await setLocal({ 'sahi:jwt': res.token, 'sahi:userEmail': email, 'sahi:emlakUrl': base });
        ui.showLoggedIn(email);
        ui.showStatus('Giriş başarılı.', 1200);
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
        if (els.loginBtn) els.loginBtn.disabled = false;
      }
    };

    els.loginBtn?.addEventListener('click', doLogin);
    els.loginPassword?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    els.logoutBtn?.addEventListener('click', async () => {
      await setLocal({ 'sahi:jwt': '', 'sahi:userEmail': '' });
      ui.showLogin();
      ui.showStatus('Çıkış yapıldı.', 1000);
    });
  }

  function bindScrapeButton() {
    const noop = () => {};
    els.btn?.addEventListener('click', async () => {
      setStatus('Çözümleme yapılıyor...');
      setOutput('');
      state.lastScrape = null;
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
        state.lastScrape = result;
        if (result?.success) {
          setStatus('Tamamlandı');
          setOutput(result.data);
          try {
            const info = await chrome.runtime.sendMessage({ type: 'getCurrentInfo', tabId });
            if (info && info.ok && (info.ilanNo || info.sourceId)) {
              if (els.ilanNoVal) els.ilanNoVal.textContent = info.ilanNo || info.sourceId || '-';
              if (els.ilanNoRow) els.ilanNoRow.style.display = 'block';
            }
          } catch (_) {}
        } else {
          setStatus(result?.error || 'Bilinmeyen hata');
          setOutput(result);
        }
      } catch (e) {
        state.lastScrape = null;
        setStatus('Hata: ' + (e?.message || e));
      }
    });
  }

  function renderNotes(notes) {
    try {
      const arr = Array.isArray(notes) ? notes : [];
      if (els.notesSection) els.notesSection.style.display = 'block';
      if (!els.notesList) return;
      if (!arr.length) {
        els.notesList.innerHTML = '<div style="color:#666;">Not yok.</div>';
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
      els.notesList.innerHTML = html;
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
    state.apiLogs.push(entry);
    if (state.apiLogs.length > 50) state.apiLogs.splice(0, state.apiLogs.length - 50);
    renderApiLogs();
  }

  function renderApiLogs() {
    if (!els.out) return;
    const lines = state.apiLogs.map(x => {
      const head = `[${x.t}] ${x.m} ${x.u} -> ${x.s || ''}`;
      const body = x.e ? `ERROR: ${x.e}` : (x.b || '');
      return head + (body ? `\n${body}` : '');
    });
    els.out.textContent = lines.join('\n\n');
  }
});
