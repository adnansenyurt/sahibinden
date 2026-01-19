// geminiClient.js - Lightweight client for Google Generative Language API (Gemini)
// MV3-compatible (no imports); to be loaded via importScripts in background.js

const HARM_SETTINGS = [
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
];

const ALLOWED_JSON_FIELDS = new Set([
  'İl / İlçe', 'İlan Başlığı', 'Bulunduğu Kat', 'Cephe', 'Çevre', 'En Yakın', 'Açıklama',
  'Cephe Çevre', 'm² (Brüt)', 'm² (Net)', 'Oda Sayısı', 'Harita', 'İlan No', 'Fiyat'
]);

function cloneJson(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch (_) { return {}; }
}

function truncateString(v, limit) {
  if (typeof v !== 'string') return v;
  return v.length > limit ? v.slice(0, limit) + '…' : v;
}

function sanitizeRecord(record) {
  const redacted = { ...(record || {}) };
  delete redacted['Image Data'];
  if (typeof redacted['Açıklama'] === 'string' && redacted['Açıklama'].length > 2000) {
    redacted['Açıklama'] = redacted['Açıklama'].slice(0, 2000) + '…';
  }
  try {
    for (const k of Object.keys(redacted)) {
      const v = redacted[k];
      if (typeof v === 'string') {
        const limit = (k === 'En Yakın' || k === 'Çevre') ? 400 : 600;
        redacted[k] = truncateString(v, limit);
      }
    }
  } catch (_) {}
  return redacted;
}

function splitCriteria(criteriaList) {
  const important = criteriaList.filter(line => /^\s*Önemli\s*:/i.test(line))
    .map(s => s.replace(/^\s*Önemli\s*:\s*/i, '').trim());
  const normal = criteriaList.filter(line => !/^\s*Önemli\s*:/i.test(line)).map(s => s.trim());
  return { important, normal };
}

function buildSystemPrompt() {
  return [
    'Sen bir emlak değerlendirme asistanısın. Bu istek bağımsızdır; önceki konuşmaları, yanıtları veya kriterleri dikkate alma.',
    'Kurallar:',
    '- Maksimum 2–3 kısa cümle yaz; toplamda 25 kelimeyi aşma.',
    '- Sadece "Önemli" olarak işaretlenen maddeler için net bir uygunluk yanıtı ver (uyuyor/uyumuyor/belirsiz).',
    '- Önemli olmayan maddeleri yalnızca vurguyu şekillendirmek için kullan; onlar hakkında açık uygunluk yanıtı verme.',
    '- Kriterlerde açıkça yer almayan konulardan bahsetme; ilanda yer almayan bilgileri varsayma.',
    '- Kanıt varsa belirsiz deme: "Açıklama" ve varsa "Cephe Çevre" içindeki ifadeleri kanıt olarak kabul et.',
    '- Kısalt ve tekrar etme. Sadece düz metin döndür (madde işaretleri/başlık kullanma).'
  ].join('\n');
}

function buildUserParts(criteriaList, record) {
  const { important, normal } = splitCriteria(criteriaList);
  const parts = [{ text: 'Kriterler:' }];
  if (important.length) parts.push({ text: 'Önemli: ' + important.join(' | ') });
  if (normal.length) parts.push({ text: 'Diğer: ' + normal.join(' | ') });
  parts.push({ text: 'İlan Verisi (JSON):' });
  parts.push({ text: JSON.stringify(sanitizeRecord(record)) });
  parts.push({ text: 'Örnek biçem:' });
  parts.push({ text: "Kadıköy'de daire. Metroya beş dakika. Dördüncü katta. Güney cephesi açık, parka bakıyor." });
  return parts;
}

function buildSummaryRequest(criteriaList, record) {
  return {
    systemInstruction: { role: 'system', parts: [{ text: buildSystemPrompt() }] },
    contents: [{ role: 'user', parts: buildUserParts(criteriaList, record) }],
    generationConfig: { temperature: 0.2, topK: 40, topP: 0.8, maxOutputTokens: 200, stopSequences: ['\n\n'] },
    safetySettings: HARM_SETTINGS
  };
}

function compactGeminiRequest(body) {
  if (body && body.__prepared) return body;
  const obj = cloneJson(body || {});

  // Remove unsupported fields and shrink payload as per previous runtime patch
  if (obj.systemInstruction) {
    delete obj.systemInstruction;
  }
  if (obj.generationConfig && Object.prototype.hasOwnProperty.call(obj.generationConfig, 'stopSequences')) {
    delete obj.generationConfig.stopSequences;
  }
  if (!obj.generationConfig) obj.generationConfig = {};
  obj.generationConfig.maxOutputTokens = 1024;

  if (Array.isArray(obj.contents)) {
    obj.contents = obj.contents.map((c) => {
      if (!c || !Array.isArray(c.parts)) return c;
      let parts = c.parts.filter((p) => {
        const t = p && typeof p.text === 'string' ? p.text : '';
        if (!t) return false;
        if (/^Örnek biçem:/i.test(t)) return false;
        if (/^Diğer\s*:/i.test(t)) return false;
        return true;
      });

      parts = parts.map((p) => {
        if (!p || typeof p.text !== 'string') return p;
        const txt = p.text.trim();
        if (txt.startsWith('{') && txt.endsWith('}')) {
          try {
            const objJson = JSON.parse(txt);
            const compact = {};
            for (const k of Object.keys(objJson)) {
              if (!ALLOWED_JSON_FIELDS.has(k)) continue;
              let v = objJson[k];
              if (typeof v === 'string') {
                let limit = 120;
                if (k === 'Açıklama') limit = 800;
                if (k === 'En Yakın' || k === 'Çevre' || k === 'Cephe Çevre') limit = 300;
                v = truncateString(v, limit);
              }
              compact[k] = v;
            }
            return { text: JSON.stringify(compact) };
          } catch (_) { return p; }
        }
        return p;
      });

      const brevityHint = 'Yanıtı 1-2 kısa cümleyle, 25 kelimeyi aşmadan, düz metin olarak ver.';
      const hasHint = parts.some((p) => typeof p?.text === 'string' && p.text.includes('25 kelimeyi aşmadan'));
      if (!hasHint) parts.push({ text: brevityHint });

      return { role: c.role, parts };
    });
  }

  obj.__prepared = true;
  return obj;
}

function buildPromptPreview(body) {
  try {
    const sys = body && body.systemInstruction && Array.isArray(body.systemInstruction.parts)
      ? body.systemInstruction.parts.map(p => (p && p.text) ? String(p.text) : '').filter(Boolean).join('\n') : '';
    const contents = Array.isArray(body && body.contents) ? body.contents : [];
    const user = contents
      .filter(c => c && (c.role === 'user' || !c.role))
      .map(c => Array.isArray(c.parts) ? c.parts.map(p => (p && p.text) ? String(p.text) : '').filter(Boolean).join('\n') : '')
      .filter(Boolean)
      .join('\n');
    const modelLine = body && body.__modelName ? `Model: ${body.__modelName}\n` : '';
    return `${modelLine}SYSTEM:\n${sys}\n\nUSER:\n${user}`.trim();
  } catch (e) {
    return '';
  }
}

async function generateSummaryWithGemini(criteriaList, record, apiKey) {
  try {
    if (!apiKey || !Array.isArray(criteriaList) || !record) return '';
    try { self.__lastGeminiPrompt = ''; self.__lastGeminiError = null; } catch (_) {}

    const preparedBody = compactGeminiRequest(buildSummaryRequest(criteriaList, record));
    try { self.__lastGeminiPrompt = buildPromptPreview(preparedBody); } catch (_) { self.__lastGeminiPrompt = ''; }

    const { text, error } = await callGeminiWithFallback(preparedBody, apiKey);
    if (error) {
      self.__lastGeminiError = error;
      return '';
    }
    return (text || '').trim();
  } catch (e) {
    self.__lastGeminiError = { message: String(e) };
    return '';
  }
}

async function callGeminiWithFallback(body, apiKey) {
  const models = ['gemini-2.5-flash'];
  let lastErr = null;

  for (const model of models) {
    const request = { ...compactGeminiRequest(body), __modelName: model };
    let result = await callGemini(request, apiKey, model);
    if (!result.error) return result;
    lastErr = result.error;

    const isEmpty200 = (!result.error.status || result.error.status === 200) && /Empty response text/i.test(String(result.error.message || ''));
    const finishReason = String(result.error && (result.error.finishReason || (result.error.json && result.error.json.candidates && result.error.json.candidates[0] && result.error.json.candidates[0].finishReason) || '')).toUpperCase();
    const isMaxTokens = finishReason === 'MAX_TOKENS';

    if (isEmpty200 || isMaxTokens) {
      try {
        const tweaked = cloneJson(request);
        tweaked.__prepared = false;
        const currentMax = (tweaked.generationConfig && tweaked.generationConfig.maxOutputTokens) || 120;
        const newMax = isMaxTokens ? Math.max(256, Math.min(512, currentMax * 2)) : Math.min(100, currentMax);
        tweaked.generationConfig = Object.assign({}, tweaked.generationConfig || {}, { maxOutputTokens: newMax, temperature: 0.2, topP: 0.8, topK: 40, stopSequences: ['\n\n'] });
        const retryTweak = await callGemini({ ...compactGeminiRequest(tweaked), __modelName: model }, apiKey, model);
        if (!retryTweak.error) return retryTweak;
        lastErr = retryTweak.error;
      } catch (_) {}
    }

    if (result.error.status && (result.error.status === 429 || (result.error.status >= 500 && result.error.status < 600))) {
      await sleep(400 + Math.floor(Math.random() * 400));
      const retry = await callGemini(request, apiKey, model);
      if (!retry.error) return retry;
      lastErr = retry.error;
    }
  }

  return { text: '', error: lastErr || { message: 'Unknown Gemini error' } };
}

async function callGemini(body, apiKey, model) {
  try {
    const url = 'https://generativelanguage.googleapis.com/v1/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
    const payload = { ...body };
    delete payload.__prepared;
    delete payload.__modelName;
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const status = resp.status;
    const raw = await safeReadText(resp);
    if (!resp.ok) {
      let jsonErr = null; try { jsonErr = JSON.parse(raw); } catch {}
      return { text: '', error: { status, body: raw, json: jsonErr } };
    }
    let data = null; try { data = JSON.parse(raw); } catch { data = {}; }
    const text = extractTextFromGeminiResponse(data);
    if (!text) {
      const firstCandidate = Array.isArray(data && data.candidates) && data.candidates.length ? data.candidates[0] : null;
      const finishReason = firstCandidate && firstCandidate.finishReason ? firstCandidate.finishReason : undefined;
      const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason ? data.promptFeedback.blockReason : undefined;
      return { text: '', error: { status, body: raw, json: data, message: 'Empty response text', finishReason, blockReason } };
    }
    return { text, error: null };
  } catch (e) {
    return { text: '', error: { message: String(e) } };
  }
}

function extractTextFromGeminiResponse(data) {
  try {
    if (!data) return '';
    const texts = [];
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    for (const cand of candidates) {
      const content = cand && cand.content;
      if (content && Array.isArray(content.parts)) {
        for (const p of content.parts) {
          if (p && typeof p.text === 'string' && p.text.trim()) texts.push(p.text);
        }
      }
      if (Array.isArray(content)) {
        for (const p of content) {
          if (p && typeof p.text === 'string' && p.text.trim()) texts.push(p.text);
        }
      }
      if (cand && typeof cand.text === 'string' && cand.text.trim()) texts.push(cand.text);
    }
    if (texts.length) return texts.join('\n').trim();
    if (data && typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  } catch (_) {}
  return '';
}

async function safeReadText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function testGeminiAPI(apiKey) {
  if (!apiKey) return { ok: false, message: 'API anahtarı girilmemiş.' };
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Sadece şu metni aynen döndür: Merhaba.' }] }],
    generationConfig: { temperature: 0.0, maxOutputTokens: 8 },
    safetySettings: HARM_SETTINGS
  };
  const { text, error } = await callGeminiWithFallback(body, apiKey);
  if (error) return { ok: false, message: formatGeminiError(error) };
  let t = (text || '').trim();
  t = t.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
  const m = t.match(/merhaba\.?/i);
  if (m || !t) t = 'Merhaba.';
  return { ok: true, text: t };
}

function formatGeminiError(err) {
  if (!err) return 'Bilinmeyen hata';
  const status = err.status ? `HTTP ${err.status}` : '';
  const block = err.blockReason || (err.json && err.json.promptFeedback && err.json.promptFeedback.blockReason);
  const finish = err.finishReason || (err.json && Array.isArray(err.json.candidates) && err.json.candidates[0] && err.json.candidates[0].finishReason);
  const jmsg = err.json && (err.json.error && err.json.error.message ? err.json.error.message : '') || '';
  const bodyMsg = err.body && err.body.slice ? err.body.slice(0, 200) : '';
  const msgParts = [err.message || jmsg || bodyMsg];
  if (block) msgParts.push(`blockReason=${block}`);
  if (finish) msgParts.push(`finishReason=${finish}`);
  const msg = msgParts.filter(Boolean).join(' ');
  return [status, msg].filter(Boolean).join(' - ');
}

async function listGeminiModels(apiKey) {
  if (!apiKey) return { ok: false, message: 'API anahtarı eksik' };
  try {
    let pageToken = '';
    const models = [];
    for (let i = 0; i < 10; i++) {
      const url = new URL('https://generativelanguage.googleapis.com/v1/models');
      url.searchParams.set('key', apiKey);
      url.searchParams.set('pageSize', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const resp = await fetch(url.toString(), { method: 'GET' });
      const status = resp.status;
      const raw = await safeReadText(resp);
      if (!resp.ok) {
        let jsonErr = null; try { jsonErr = JSON.parse(raw); } catch {}
        return { ok: false, message: formatGeminiError({ status, body: raw, json: jsonErr }) };
      }
      let data = null; try { data = JSON.parse(raw); } catch { data = {}; }
      const list = Array.isArray(data.models) ? data.models : [];
      for (const m of list) {
        models.push({
          name: m.name || '',
          displayName: m.displayName || '',
          description: m.description || '',
          inputTokenLimit: m.inputTokenLimit,
          outputTokenLimit: m.outputTokenLimit,
          supportedGenerationMethods: m.supportedGenerationMethods || [],
        });
      }
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }
    return { ok: true, models };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

self.generateSummaryWithGemini = generateSummaryWithGemini;
self.testGeminiAPI = testGeminiAPI;
self.formatGeminiError = formatGeminiError;
self.listGeminiModels = listGeminiModels;
