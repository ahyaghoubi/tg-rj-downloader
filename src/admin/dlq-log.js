import {
  ADMIN_DLQ_EVENTS_KEY,
  ADMIN_DLQ_EVENTS_LIMIT,
  getJobStore,
  putKv,
  KvWriteLimitError,
} from "../config.js";
import { normalizeArtistName } from "../rj/urls.js";

async function readDlqEvents(env) {
  const kv = getJobStore(env);
  if (!kv) {
    return [];
  }
  try {
    const raw = await kv.get(ADMIN_DLQ_EVENTS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function recordDlqEvent(env, payload, { retryCount = 0, autoRetried = false } = {}) {
  const kv = getJobStore(env);
  if (!kv || !payload) {
    return;
  }
  try {
    const events = await readDlqEvents(env);
    const entry = {
      at: new Date().toISOString(),
      chatId: payload.chatId != null ? String(payload.chatId) : null,
      artistName: normalizeArtistName(payload.artistName || "") || null,
      nextIndex: payload.nextIndex ?? null,
      total: payload.total ?? null,
      sent: payload.sent ?? null,
      retryCount,
      autoRetried: Boolean(autoRetried),
      failed: Array.isArray(payload.failed) ? payload.failed.slice(0, 5) : [],
    };
    const next = [entry, ...events].slice(0, ADMIN_DLQ_EVENTS_LIMIT);
    await putKv(kv, ADMIN_DLQ_EVENTS_KEY, JSON.stringify(next), {
      expirationTtl: 90 * 24 * 60 * 60,
    });
  } catch (err) {
    if (!(err instanceof KvWriteLimitError)) {
      console.warn(`recordDlqEvent failed: ${err.message}`);
    }
  }
}

export { readDlqEvents, recordDlqEvent };
