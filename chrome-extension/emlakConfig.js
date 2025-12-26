// Shared configuration for Emlak API base handling (used by popup and background)
const DEFAULT_EMLAK_BASE_URL = 'http://localhost:8084';

function resolveEmlakBaseUrl(value) {
  try {
    const base = (value || DEFAULT_EMLAK_BASE_URL).trim();
    return base.replace(/\/$/, '');
  } catch (_) {
    return (value || DEFAULT_EMLAK_BASE_URL || '').replace(/\/$/, '');
  }
}

try {
  self.EMLAK_CONFIG = Object.freeze({
    DEFAULT_EMLAK_BASE_URL,
    resolveEmlakBaseUrl
  });
} catch (_) {}
