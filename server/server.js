const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// NEW: Request/Response logging middleware (GET/POST)
const requestResponseLogger = (req, res, next) => {
  if (!['GET', 'POST'].includes(req.method)) return next();

  const { method, originalUrl } = req;
  const redactedHeaders = { ...req.headers };
  if (redactedHeaders.authorization) redactedHeaders.authorization = '[REDACTED]';

  console.log(`[REQ] ${method} ${originalUrl}`, {
    headers: redactedHeaders,
    params: req.params,
    query: req.query,
    body: req.body,
  });

  const oldJson = res.json.bind(res);
  const oldSend = res.send.bind(res);

  const logResponse = (payload) => {
    let out = payload;
    try {
      if (Buffer.isBuffer(payload)) out = payload.toString('utf8');
    } catch (_) {}
    console.log(`[RES] ${method} ${originalUrl} ${res.statusCode}`, out);
  };

  res.json = (body) => {
    logResponse(body);
    return oldJson(body);
  };

  res.send = (body) => {
    logResponse(body);
    return oldSend(body);
  };

  next();
};

app.use(requestResponseLogger);

// Handle devtools request
app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
    res.json({});
});

// Default route
app.get('/', (req, res) => {
    res.send('Server is running');
});

// Simplified health endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// In-memory store for demo (replace with DB)
const notes = new Map();

// Middleware to check JWT
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  // TODO: Validate JWT
  next();
};

// Note endpoints

// Bulk upsert endpoint: accepts { items: [{ id, note, privNote, updatedAt? }, ...] }
app.post('/api/notes/bulk', authMiddleware, (req, res) => {
  const body = req.body || {};
  let { items } = body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'items must be an array' });
  }

  const results = [];
  let count = 0;
  const nowIso = new Date().toISOString();

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const id = raw.id != null ? String(raw.id) : '';
    const note = typeof raw.note === 'string' ? raw.note.trim() : '';
    const privNote = typeof raw.privNote === 'string' ? raw.privNote.trim() : '';

    if (!id) continue;

    // Public note
    if (note) {
      const pubObj = {
        rowId: id,
        note,
        kind: 'normal',
        updatedAt: raw.updatedAt || nowIso,
      };
      notes.set(`${id}:normal`, pubObj);
      results.push({ success: true, ...pubObj });
      count++;
    }

    // Private note
    if (privNote) {
      const privObj = {
        rowId: id,
        note: privNote,
        kind: 'private',
        updatedAt: raw.updatedAt || nowIso,
      };
      notes.set(`${id}:private`, privObj);
      results.push({ success: true, ...privObj });
      count++;
    }
  }

  return res.json({ success: true, count, items: results });
});

app.post('/api/notes/:adId', authMiddleware, (req, res) => {
  const pathAdId = req.params.adId;
  const payload = req.body || {};
  let { rowId, note, kind } = payload;

  // Infer rowId from path if not provided in body
  if (rowId == null) rowId = pathAdId;
  if (!kind) kind = 'normal';

  if (!rowId) {
    return res.status(400).json({ error: 'rowId is required (in body or path)' });
  }
  // Only enforce mismatch if body explicitly provided rowId
  if (payload.rowId && pathAdId && payload.rowId !== pathAdId) {
    return res.status(400).json({ error: 'rowId in body does not match adId in path' });
  }
  if (typeof note !== 'string' || !note.trim()) {
    return res.status(400).json({ error: 'note is required and must be a non-empty string' });
  }
  if (!['normal', 'private'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be one of: normal, private' });
  }

  // Ensure rowId is present; drop any accidental success flag
  const toStore = { rowId, ...payload };
  delete toStore.success;

  // Ensure updatedAt exists if the extension didn't provide it
  if (!toStore.updatedAt) {
    toStore.updatedAt = new Date().toISOString();
  }

  // Store by composite key so normal/private are separate entries
  const key = `${rowId}:${kind}`;
  notes.set(key, toStore);

  return res.json({ success: true, ...toStore });
});

app.get('/api/notes', authMiddleware, (req, res) => {
  // Return stored notes exactly as posted
  res.json(Array.from(notes.values()));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
