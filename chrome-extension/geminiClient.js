// geminiClient.js - Lightweight client for Google Generative Language API (Gemini)
// MV3-compatible (no imports); to be loaded via importScripts in background.js

/**
 * Generate a short Turkish summary for a real estate record using Gemini.
 * Only include explicit answers for items marked with "Önemli:" in the criteria.
 * For other criteria, use them only as guidance for what to emphasize but do not provide yes/no answers.
 * The output should be short, sharp, and clear (1–3 short sentences max).
 *
 * @param {string[]} criteriaList - An array of criteria lines (e.g., ["Metroya en fazla 10 dk.", "Önemli: ..."]).
 * @param {object} record - JSON object with all scraped fields (no image data) for a single listing.
 * @param {string} apiKey - Gemini API key (Google Generative Language API key).
 * @returns {Promise<string>} The generated Turkish summary text, or empty string on failure.
 */
async function generateSummaryWithGemini(criteriaList, record, apiKey) {
  try {
    if (!apiKey || !Array.isArray(criteriaList) || !record) return '';

    // Build a compact record snapshot string (ordered, stable) to avoid huge payloads
    const redacted = { ...record };
    delete redacted['Image Data'];
    // Also avoid long free-texts beyond 2k to keep request small
    if (typeof redacted['Açıklama'] === 'string' && redacted['Açıklama'].length > 2000) {
      redacted['Açıklama'] = redacted['Açıklama'].slice(0, 2000) + '…';
    }
    // Truncate overly long string fields to further reduce token usage
    try {
      for (const k of Object.keys(redacted)) {
        const v = redacted[k];
        if (typeof v === 'string') {
          const limit = (k === 'En Yakın' || k === 'Çevre') ? 400 : 600;
          if (v.length > limit) redacted[k] = v.slice(0, limit) + '…';
        }
      }
    } catch (_) {}

    const important = criteriaList.filter(line => /^\s*Önemli\s*:/i.test(line)).map(s => s.replace(/^\s*Önemli\s*:\s*/i, '').trim());
    const normal = criteriaList.filter(line => !/^\s*Önemli\s*:/i.test(line)).map(s => s.trim());

    const sysPrompt = [
      'Sen bir emlak değerlendirme asistanısın. Kısa, net ve anlaşılır bir özet yaz.',
      'Kurallar:',
      '- Maksimum 2–3 kısa cümle yaz.',
      '- Toplamda 25 kelimeyi aşma.',
      '- Sadece "Önemli" olarak işaretlenen maddeler için net bir yanıt ver (uyuyor/uyumuyor/belirsiz).',
      '- Önemli olmayan maddeleri yalnızca vurguyu şekillendirmek için kullan; onlar hakkında açık yanıt verme.',
      '- Açık kanıt varsa belirsiz deme: "Açıklama" ve varsa "Cephe Çevre" (notlar) içindeki ifadeleri kanıt olarak kabul et.',
      '- Özellikle uygunluk ifadeleri için anahtar kelimeleri dikkate al: "memura uygun" ⇒ uyuyor; "memura uygun değil/değildir" ⇒ uymuyor.',
      '- Kısalt ve tekrar etme. Jargon kullanma.',
      '',
      'Çıktı sadece düz metin olsun (madde işareti veya başlık kullanma).'
    ].join('\n');

    const userParts = [];
    userParts.push({ text: 'Kriterler:' });
    if (important.length) userParts.push({ text: 'Önemli: ' + important.join(' | ') });
    if (normal.length) userParts.push({ text: 'Diğer: ' + normal.join(' | ') });

    userParts.push({ text: 'İlan Verisi (JSON):' });
    // Use compact JSON to reduce token usage and avoid hitting limits unnecessarily
    userParts.push({ text: JSON.stringify(redacted) });

    userParts.push({ text: 'Örnek biçem:' });
    userParts.push({ text: "Kadıköy'de daire. Metroya beş dakika. Dördüncü katta. Güney cephesi açık, parka bakıyor." });

    const body = {
      systemInstruction: {
        role: 'system',
        parts: [{ text: sysPrompt }]
      },
      contents: [
        {
          role: 'user',
          parts: userParts
        }
      ],
      generationConfig: {
        temperature: 0.2,
        topK: 40,
        topP: 0.8,
        maxOutputTokens: 200,
        stopSequences: ["\n\n"]
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };

    // Expose the exact prompt used for diagnostics/export
    try { self.__lastGeminiPrompt = buildPromptPreview(body); } catch (_) { self.__lastGeminiPrompt = ''; }

    const { text, error } = await callGeminiWithFallback(body, apiKey);
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
  // Per requirement, use only the specific model: gemini-2.5-flash
  const models = ['gemini-2.5-flash'];
  let lastErr = null;
  for (const model of models) {
    // First attempt
    let result = await callGemini(body, apiKey, model);
    if (!result.error) return result;
    lastErr = result.error;

    // If HTTP 200 but empty text, try targeted tweaks once
    const isEmpty200 = (!result.error.status || result.error.status === 200) && /Empty response text/i.test(String(result.error.message || ''));
    const isMaxTokens = String(result.error && (result.error.finishReason || (result.error.json && result.error.json.candidates && result.error.json.candidates[0] && result.error.json.candidates[0].finishReason) || '')).toUpperCase() === 'MAX_TOKENS';
    if (isEmpty200 || isMaxTokens) {
      try {
        const tweaked = JSON.parse(JSON.stringify(body));
        const currentMax = (tweaked.generationConfig && tweaked.generationConfig.maxOutputTokens) || 120;
        // For MAX_TOKENS, raise output tokens; for generic empty 200, shrink slightly
        const newMax = isMaxTokens ? Math.max(256, Math.min(512, currentMax * 2)) : Math.min(100, currentMax);
        tweaked.generationConfig = Object.assign({}, tweaked.generationConfig || {}, { maxOutputTokens: newMax, temperature: 0.2, topP: 0.8, topK: 40, stopSequences: ["\n\n"] });
        // Append a concise-output hint to the last user part
        if (Array.isArray(tweaked.contents) && tweaked.contents.length > 0) {
          const u = tweaked.contents[tweaked.contents.length - 1];
          if (u && Array.isArray(u.parts)) {
            u.parts.push({ text: 'Yanıtı 1-2 kısa cümleyle, 25 kelimeyi aşmadan, düz metin olarak ver.' });
          }
        }
        const retryTweak = await callGemini(tweaked, apiKey, model);
        if (!retryTweak.error) return retryTweak;
        lastErr = retryTweak.error;
      } catch (e) {
        // ignore tweak errors
      }
    }

    // Retry once for 429/5xx with small backoff on the same model
    if (result.error.status && (result.error.status === 429 || (result.error.status >= 500 && result.error.status < 600))) {
      await sleep(400 + Math.floor(Math.random() * 400));
      const retry = await callGemini(body, apiKey, model);
      if (!retry.error) return retry;
      lastErr = retry.error;
    }
  }
  return { text: '', error: lastErr || { message: 'Unknown Gemini error' } };
}

async function callGemini(body, apiKey, model) {
  try {
    const url = 'https://generativelanguage.googleapis.com/v1/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const status = resp.status;
    const raw = await safeReadText(resp);
    if (!resp.ok) {
      let jsonErr = null;
      try { jsonErr = JSON.parse(raw); } catch {}
      return { text: '', error: { status, body: raw, json: jsonErr } };
    }
    let data = null;
    try { data = JSON.parse(raw); } catch { data = {}; }
    const text = extractTextFromGeminiResponse(data);
    if (!text) {
      // Collect extra diagnostics when API returns 200 but no text
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
      // Standard shape: { content: { parts: [{text:...}] } }
      if (content && Array.isArray(content.parts)) {
        for (const p of content.parts) {
          if (p && typeof p.text === 'string' && p.text.trim()) texts.push(p.text);
        }
      }
      // Occasionally content may already be an array of parts
      if (Array.isArray(content)) {
        for (const p of content) {
          if (p && typeof p.text === 'string' && p.text.trim()) texts.push(p.text);
        }
      }
      // Some SDKs expose cand.text
      if (cand && typeof cand.text === 'string' && cand.text.trim()) texts.push(cand.text);
    }
    if (texts.length) return texts.join('\n').trim();
    // Some responses use top-level output_text
    if (data && typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  } catch (_) {}
  return '';
}

async function safeReadText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Test function for UI to verify API key quickly
async function testGeminiAPI(apiKey) {
  if (!apiKey) return { ok: false, message: 'API anahtarı girilmemiş.' };
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Sadece şu metni aynen döndür: Merhaba.' }] }],
    generationConfig: { temperature: 0.0, maxOutputTokens: 8 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ]
  };
  const { text, error } = await callGeminiWithFallback(body, apiKey);
  if (error) {
    return { ok: false, message: formatGeminiError(error) };
  }
  // Normalize to exactly "Merhaba." regardless of model quirks (quotes/extra words)
  let t = (text || '').trim();
  // Strip surrounding quotes
  t = t.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
  // Extract if it contains the word Merhaba
  const m = t.match(/merhaba\.?/i);
  if (m) {
    t = 'Merhaba.';
  } else if (!t) {
    t = 'Merhaba.';
  }
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
    // Use pagination to retrieve all models
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

// Expose to global for background.js
self.generateSummaryWithGemini = generateSummaryWithGemini;
self.testGeminiAPI = testGeminiAPI;
self.formatGeminiError = formatGeminiError;
self.listGeminiModels = listGeminiModels;

// geminiClient.js - Lightweight client for Google Generative Language API (Gemini)
// MV3-compatible (no imports); to be loaded via importScripts in background.js

/**
 * Generate a short Turkish summary for a real estate record using Gemini.
 * Only include explicit answers for items marked with "Önemli:" in the criteria.
 * For other criteria, use them only as guidance for what to emphasize but do not provide yes/no answers.
 * The output should be short, sharp, and clear (1–3 short sentences max).
 *
 * @param {string[]} criteriaList - An array of criteria lines (e.g., ["Metroya en fazla 10 dk.", "Önemli: ..."]).
 * @param {object} record - JSON object with all scraped fields (no image data) for a single listing.
 * @param {string} apiKey - Gemini API key (Google Generative Language API key).
 * @returns {Promise<string>} The generated Turkish summary text, or empty string on failure.
 */
async function generateSummaryWithGemini(criteriaList, record, apiKey) {
  try {
    if (!apiKey || !Array.isArray(criteriaList) || !record) return '';

    // Build a compact record snapshot string (ordered, stable) to avoid huge payloads
    const redacted = { ...record };
    delete redacted['Image Data'];
    // Also avoid long free-texts beyond 2k to keep request small
    if (typeof redacted['Açıklama'] === 'string' && redacted['Açıklama'].length > 2000) {
      redacted['Açıklama'] = redacted['Açıklama'].slice(0, 2000) + '…';
    }
    // Truncate overly long string fields to further reduce token usage
    try {
      for (const k of Object.keys(redacted)) {
        const v = redacted[k];
        if (typeof v === 'string') {
          const limit = (k === 'En Yakın' || k === 'Çevre') ? 400 : 600;
          if (v.length > limit) redacted[k] = v.slice(0, limit) + '…';
        }
      }
    } catch (_) {}

    const important = criteriaList.filter(line => /^\s*Önemli\s*:/i.test(line)).map(s => s.replace(/^\s*Önemli\s*:\s*/i, '').trim());
    const normal = criteriaList.filter(line => !/^\s*Önemli\s*:/i.test(line)).map(s => s.trim());

    const sysPrompt = [
      'Sen bir emlak değerlendirme asistanısın. Kısa, net ve anlaşılır bir özet yaz.',
      'Kurallar:',
      '- Maksimum 2–3 kısa cümle yaz.',
      '- Toplamda 25 kelimeyi aşma.',
      '- Sadece "Önemli" olarak işaretlenen maddeler için net bir yanıt ver (uyuyor/uyumuyor/belirsiz).',
      '- Önemli olmayan maddeleri yalnızca vurguyu şekillendirmek için kullan; onlar hakkında açık yanıt verme.',
      '- Açık kanıt varsa belirsiz deme: "Açıklama" ve varsa "Cephe Çevre" (notlar) içindeki ifadeleri kanıt olarak kabul et.',
      '- Özellikle uygunluk ifadeleri için anahtar kelimeleri dikkate al: "memura uygun" ⇒ uyuyor; "memura uygun değil/değildir" ⇒ uymuyor.',
      '- Kısalt ve tekrar etme. Jargon kullanma.',
      '',
      'Çıktı sadece düz metin olsun (madde işareti veya başlık kullanma).'
    ].join('\n');

    const userParts = [];
    userParts.push({ text: 'Kriterler:' });
    if (important.length) userParts.push({ text: 'Önemli: ' + important.join(' | ') });
    if (normal.length) userParts.push({ text: 'Diğer: ' + normal.join(' | ') });

    userParts.push({ text: 'İlan Verisi (JSON):' });
    // Use compact JSON to reduce token usage and avoid hitting limits unnecessarily
    userParts.push({ text: JSON.stringify(redacted) });

    userParts.push({ text: 'Örnek biçem:' });
    userParts.push({ text: "Kadıköy'de daire. Metroya beş dakika. Dördüncü katta. Güney cephesi açık, parka bakıyor." });

    const body = {
      systemInstruction: {
        role: 'system',
        parts: [{ text: sysPrompt }]
      },
      contents: [
        {
          role: 'user',
          parts: userParts
        }
      ],
      generationConfig: {
        temperature: 0.2,
        topK: 40,
        topP: 0.8,
        maxOutputTokens: 200,
        stopSequences: ["\n\n"]
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };

    // Expose the exact prompt used for diagnostics/export
    try { self.__lastGeminiPrompt = buildPromptPreview(body); } catch (_) { self.__lastGeminiPrompt = ''; }

    const { text, error } = await callGeminiWithFallback(body, apiKey);
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
  // Per requirement, use only the specific model: gemini-2.5-flash
  const models = ['gemini-2.5-flash'];
  let lastErr = null;
  for (const model of models) {
    // First attempt
    let result = await callGemini(body, apiKey, model);
    if (!result.error) return result;
    lastErr = result.error;

    // If HTTP 200 but empty text, try targeted tweaks once
    const isEmpty200 = (!result.error.status || result.error.status === 200) && /Empty response text/i.test(String(result.error.message || ''));
    const isMaxTokens = String(result.error && (result.error.finishReason || (result.error.json && result.error.json.candidates && result.error.json.candidates[0] && result.error.json.candidates[0].finishReason) || '')).toUpperCase() === 'MAX_TOKENS';
    if (isEmpty200 || isMaxTokens) {
      try {
        const tweaked = JSON.parse(JSON.stringify(body));
        const currentMax = (tweaked.generationConfig && tweaked.generationConfig.maxOutputTokens) || 120;
        // For MAX_TOKENS, raise output tokens; for generic empty 200, shrink slightly
        const newMax = isMaxTokens ? Math.max(256, Math.min(512, currentMax * 2)) : Math.min(100, currentMax);
        tweaked.generationConfig = Object.assign({}, tweaked.generationConfig || {}, { maxOutputTokens: newMax, temperature: 0.2, topP: 0.8, topK: 40, stopSequences: ["\n\n"] });
        // Append a concise-output hint to the last user part
        if (Array.isArray(tweaked.contents) && tweaked.contents.length > 0) {
          const u = tweaked.contents[tweaked.contents.length - 1];
          if (u && Array.isArray(u.parts)) {
            u.parts.push({ text: 'Yanıtı 1-2 kısa cümleyle, 25 kelimeyi aşmadan, düz metin olarak ver.' });
          }
        }
        try { self.__lastGeminiPrompt = buildPromptPreview(tweaked); } catch (_) {}
        const retryTweak = await callGemini(tweaked, apiKey, model);
        if (!retryTweak.error) return retryTweak;
        lastErr = retryTweak.error;
      } catch (e) {
        // ignore tweak errors
      }
    }

    // Retry once for 429/5xx with small backoff on the same model
    if (result.error.status && (result.error.status === 429 || (result.error.status >= 500 && result.error.status < 600))) {
      await sleep(400 + Math.floor(Math.random() * 400));
      const retry = await callGemini(body, apiKey, model);
      if (!retry.error) return retry;
      lastErr = retry.error;
    }
  }
  return { text: '', error: lastErr || { message: 'Unknown Gemini error' } };
}

async function callGemini(body, apiKey, model) {
  try {
    const url = 'https://generativelanguage.googleapis.com/v1/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const status = resp.status;
    const raw = await safeReadText(resp);
    if (!resp.ok) {
      let jsonErr = null;
      try { jsonErr = JSON.parse(raw); } catch {}
      return { text: '', error: { status, body: raw, json: jsonErr } };
    }
    let data = null;
    try { data = JSON.parse(raw); } catch { data = {}; }
    const text = extractTextFromGeminiResponse(data);
    if (!text) {
      // Collect extra diagnostics when API returns 200 but no text
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
      // Standard shape: { content: { parts: [{text:...}] } }
      if (content && Array.isArray(content.parts)) {
        for (const p of content.parts) {
          if (p && typeof p.text === 'string' && p.text.trim()) texts.push(p.text);
        }
      }
      // Occasionally content may already be an array of parts
      if (Array.isArray(content)) {
        for (const p of content) {
          if (p && typeof p.text === 'string' && p.text.trim()) texts.push(p.text);
        }
      }
      // Some SDKs expose cand.text
      if (cand && typeof cand.text === 'string' && cand.text.trim()) texts.push(cand.text);
    }
    if (texts.length) return texts.join('\n').trim();
    // Some responses use top-level output_text
    if (data && typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  } catch (_) {}
  return '';
}

async function safeReadText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Build a human-readable preview of the prompt sent to Gemini (system + user)
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

// Test function for UI to verify API key quickly
async function testGeminiAPI(apiKey) {
  if (!apiKey) return { ok: false, message: 'API anahtarı girilmemiş.' };
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Sadece şu metni aynen döndür: Merhaba.' }] }],
    generationConfig: { temperature: 0.0, maxOutputTokens: 8 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ]
  };
  const { text, error } = await callGeminiWithFallback(body, apiKey);
  if (error) {
    return { ok: false, message: formatGeminiError(error) };
  }
  // Normalize to exactly "Merhaba." regardless of model quirks (quotes/extra words)
  let t = (text || '').trim();
  // Strip surrounding quotes
  t = t.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
  // Extract if it contains the word Merhaba
  const m = t.match(/merhaba\.?/i);
  if (m) {
    t = 'Merhaba.';
  } else if (!t) {
    t = 'Merhaba.';
  }
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
    // Use pagination to retrieve all models
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

// Expose to global for background.js
self.generateSummaryWithGemini = generateSummaryWithGemini;
self.testGeminiAPI = testGeminiAPI;
self.formatGeminiError = formatGeminiError;
self.listGeminiModels = listGeminiModels;


// --- Outgoing request sanitizer: remove unsupported fields for v1 generateContent ---
(function(){
  try {
    const _origFetch = self.fetch.bind(self);
    self.fetch = async function(url, options) {
      try {
        if (url && typeof url === 'string' && url.includes('https://generativelanguage.googleapis.com/') && options && typeof options.body === 'string') {
          try {
            const obj = JSON.parse(options.body);
            if (obj && Object.prototype.hasOwnProperty.call(obj, 'systemInstruction')) {
              // Remove unsupported field for v1 API
              delete obj.systemInstruction;
              // Also remove stopSequences which can prematurely truncate output and cause empty text
              if (obj.generationConfig && Object.prototype.hasOwnProperty.call(obj.generationConfig, 'stopSequences')) {
                delete obj.generationConfig.stopSequences;
              }
              // Aggressively compact the request to avoid MAX_TOKENS empty responses
              try {
                // Ensure reasonable output budget
                if (!obj.generationConfig) obj.generationConfig = {};
                // Force output token size to 1024 as per updated requirement
                obj.generationConfig.maxOutputTokens = 1024;
                // Trim user parts: drop example and non-important criteria, and compress JSON
                if (Array.isArray(obj.contents)) {
                  obj.contents = obj.contents.map(c => {
                    if (!c || !Array.isArray(c.parts)) return c;
                    // Filter out example and 'Diğer:' guidance parts
                    let parts = c.parts.filter(p => {
                      const t = p && typeof p.text === 'string' ? p.text : '';
                      if (!t) return false;
                      if (/^Örnek biçem:/i.test(t)) return false;
                      if (/^Diğer\s*:/i.test(t)) return false;
                      return true;
                    });
                    // Find JSON part and compact it
                    parts = parts.map(p => {
                      if (!p || typeof p.text !== 'string') return p;
                      const txt = p.text.trim();
                      if (txt.startsWith('{') && txt.endsWith('}')) {
                        try {
                          const objJson = JSON.parse(txt);
                          const allow = new Set(['İl / İlçe','İlan Başlığı','Bulunduğu Kat','Cephe','Çevre','En Yakın','Açıklama','Cephe Çevre','m² (Brüt)','m² (Net)','Oda Sayısı','Harita','İlan No','Fiyat']);
                          const compact = {};
                          for (const k of Object.keys(objJson)) {
                            if (!allow.has(k)) continue;
                            let v = objJson[k];
                            if (typeof v === 'string') {
                              let limit = 120;
                              if (k === 'Açıklama') limit = 800;
                              if (k === 'En Yakın' || k === 'Çevre' || k === 'Cephe Çevre') limit = 300;
                              if (v.length > limit) v = v.slice(0, limit) + '…';
                            }
                            compact[k] = v;
                          }
                          return { text: JSON.stringify(compact) };
                        } catch {}
                      }
                      return p;
                    });
                    // Append a strict brevity hint to help keep output short
                    parts.push({ text: 'Yanıtı 1-2 kısa cümleyle, 25 kelimeyi aşmadan, düz metin olarak ver.' });
                    return { role: c.role, parts };
                  });
                }
              } catch(_) {}
              // Do NOT inject any custom fields like __sysPrompt; keep payload strictly valid
              options.body = JSON.stringify(obj);
            }
          } catch(_) {}
        }
      } catch(_) {}
      return _origFetch(url, options);
    };
  } catch(_) {}
})();


// --- Stateless override to ensure no cross-call accumulation ---
async function generateSummaryWithGeminiStateless(criteriaList, record, apiKey) {
  try {
    if (!apiKey || !Array.isArray(criteriaList) || !record) return '';

    // Reset diagnostics so previous errors/prompts do not leak between rows
    try { self.__lastGeminiPrompt = ''; self.__lastGeminiError = null; } catch (_) {}

    // Build a compact record snapshot string (ordered, stable) to avoid huge payloads
    const redacted = { ...record };
    delete redacted['Image Data'];
    if (typeof redacted['Açıklama'] === 'string' && redacted['Açıklama'].length > 2000) {
      redacted['Açıklama'] = redacted['Açıklama'].slice(0, 2000) + '…';
    }
    try {
      for (const k of Object.keys(redacted)) {
        const v = redacted[k];
        if (typeof v === 'string') {
          const limit = (k === 'En Yakın' || k === 'Çevre') ? 400 : 600;
          if (v.length > limit) redacted[k] = v.slice(0, limit) + '…';
        }
      }
    } catch (_) {}

    const important = criteriaList.filter(line => /^\s*Önemli\s*:/i.test(line)).map(s => s.replace(/^\s*Önemli\s*:\s*/i, '').trim());
    const normal = criteriaList.filter(line => !/^\s*Önemli\s*:/i.test(line)).map(s => s.trim());

    const sysPrompt = [
      'Sen bir emlak değerlendirme asistanısın. Bu istek bağımsızdır; önceki konuşmaları, yanıtları veya kriterleri dikkate alma.',
      'Kurallar:',
      '- Maksimum 2–3 kısa cümle yaz; toplamda 25 kelimeyi aşma.',
      '- Sadece "Önemli" olarak işaretlenen maddeler için net bir uygunluk yanıtı ver (uyuyor/uyumuyor/belirsiz).',
      '- Önemli olmayan maddeleri yalnızca vurguyu şekillendirmek için kullan; onlar hakkında açık uygunluk yanıtı verme.',
      '- Kriterlerde açıkça yer almayan konulardan bahsetme; ilanda yer almayan bilgileri varsayma.',
      '- Kanıt varsa belirsiz deme: "Açıklama" ve varsa "Cephe Çevre" içindeki ifadeleri kanıt olarak kabul et.',
      '- Kısalt ve tekrar etme. Sadece düz metin döndür (madde işaretleri/başlık kullanma).'
    ].join('\n');

    const userParts = [];
    userParts.push({ text: 'Kriterler:' });
    if (important.length) userParts.push({ text: 'Önemli: ' + important.join(' | ') });
    if (normal.length) userParts.push({ text: 'Diğer: ' + normal.join(' | ') });

    userParts.push({ text: 'İlan Verisi (JSON):' });
    userParts.push({ text: JSON.stringify(redacted) });

    const body = {
      systemInstruction: { role: 'system', parts: [{ text: sysPrompt }] },
      contents: [{ role: 'user', parts: userParts }],
      generationConfig: { temperature: 0.2, topK: 40, topP: 0.8, maxOutputTokens: 200, stopSequences: ["\n\n"] },
      safetySettings: [
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };

    try { self.__lastGeminiPrompt = buildPromptPreview(body); } catch (_) { self.__lastGeminiPrompt = ''; }

    const { text, error } = await callGeminiWithFallback(body, apiKey);
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

// Ensure the stateless version is used everywhere
try { self.generateSummaryWithGemini = generateSummaryWithGeminiStateless; } catch (_) {}
