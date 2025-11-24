// Minimal popup controller to trigger scraping and send result to remote API

const DEFAULT_BASE_URL = 'http://localhost:8080';
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
  const sendBtn = document.getElementById('sendBtn');
  const baseUrlInput = document.getElementById('emlakBaseUrl');
  const loginView = document.getElementById('loginView');
  const loggedInView = document.getElementById('loggedInView');
  const loggedInEmailEl = document.getElementById('loggedInEmail');
  const loginEmail = document.getElementById('loginEmail');
  const loginPassword = document.getElementById('loginPassword');
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  let lastScrape = null;

  // Load base URL
  (async () => {
    const saved = await getLocal('sahi:emlakUrl');
    baseUrlInput && (baseUrlInput.value = saved || DEFAULT_BASE_URL);
  })();
  baseUrlInput?.addEventListener('change', async () => {
    const val = (baseUrlInput.value || '').trim();
    await setLocal({ 'sahi:emlakUrl': val || DEFAULT_BASE_URL });
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
      const base = (baseUrlInput?.value || '').trim() || (await getLocal('sahi:emlakUrl')) || DEFAULT_BASE_URL;
      const baseClean = base.replace(/\/$/, '');
      // Delegate login to background to avoid CORS from popup
      const res = await chrome.runtime.sendMessage({ type: 'emlakLogin', email, password, baseUrl: baseClean });
      if (!res?.ok || !res.token) throw new Error(res?.error || 'Kimlik doğrulama başarısız.');

      await setLocal({ 'sahi:jwt': res.token, 'sahi:userEmail': email, 'sahi:emlakUrl': baseClean });
      showLoggedIn(email);
      setStatus('Giriş başarılı.');
      setTimeout(() => setStatus(''), 1200);
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

  function updateSendEnabled() {
    if (sendBtn) sendBtn.disabled = !lastScrape || !lastScrape.success;
  }
  updateSendEnabled();

  btn?.addEventListener('click', async () => {
    setStatus('Çözümleme yapılıyor...');
    setOutput('');
    lastScrape = null;
    updateSendEnabled();
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
      } else {
        setStatus(result?.error || 'Bilinmeyen hata');
        setOutput(result);
      }
    } catch (e) {
      lastScrape = null;
      setStatus('Hata: ' + (e?.message || e));
    } finally {
      updateSendEnabled();
    }
  });

  sendBtn?.addEventListener('click', async () => {
    if (!lastScrape || !lastScrape.success) {
      setStatus('Önce sayfayı tara.');
      return;
    }
    try {
      sendBtn.disabled = true;
      setStatus('API\'ye gönderiliyor…');
      const res = await chrome.runtime.sendMessage({ type: 'emlakSend', data: lastScrape.data });
      if (res?.ok) {
        setStatus('API gönderimi başarılı.');
      } else {
        setStatus('API gönderimi başarısız: ' + (res?.error || JSON.stringify(res)));
      }
    } catch (e) {
      setStatus('Hata: ' + (e?.message || e));
    } finally {
      sendBtn.disabled = false;
    }
  });
});
