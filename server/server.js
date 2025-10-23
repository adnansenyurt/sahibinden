const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

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
app.post('/api/notes/:adId', authMiddleware, (req, res) => {
  const { adId } = req.params;
  const { note } = req.body;
  notes.set(adId, { note, updatedAt: new Date().toISOString() });
  res.json({ success: true });
});

app.get('/api/notes', authMiddleware, (req, res) => {
  res.json(Array.from(notes.entries()).map(([adId, data]) => ({
    adId,
    ...data
  })));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
