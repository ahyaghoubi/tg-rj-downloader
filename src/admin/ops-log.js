import {
  ADMIN_AUDIT_KEY,
  ADMIN_AUDIT_LIMIT,
  ADMIN_ERRORS_KEY,
  ADMIN_ERRORS_LIMIT,
  getJobStore,
  putKv,
  KvWriteLimitError,
} from "../config.js";

async function readJsonList(env, key) {
  const kv = getJobStore(env);
  if (!kv) {
    return [];
  }
  try {
    const raw = await kv.get(key);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function pushJsonList(env, key, entry, limit) {
  const kv = getJobStore(env);
  if (!kv) {
    return;
  }
  try {
    const list = await readJsonList(env, key);
    const next = [entry, ...list].slice(0, limit);
    await putKv(kv, key, JSON.stringify(next), { expirationTtl: 90 * 24 * 60 * 60 });
  } catch (err) {
    if (!(err instanceof KvWriteLimitError)) {
      console.warn(`pushJsonList(${key}) failed: ${err.message}`);
    }
  }
}

async function recordAdminError(env, { where, message, chatId = null, detail = null } = {}) {
  await pushJsonList(
    env,
    ADMIN_ERRORS_KEY,
    {
      at: new Date().toISOString(),
      where: String(where || "unknown").slice(0, 80),
      message: String(message || "").slice(0, 400),
      chatId: chatId != null ? String(chatId) : null,
      detail: detail != null ? String(detail).slice(0, 400) : null,
    },
    ADMIN_ERRORS_LIMIT
  );
}

async function recordAdminAudit(env, { action, chatId = null, detail = null } = {}) {
  await pushJsonList(
    env,
    ADMIN_AUDIT_KEY,
    {
      at: new Date().toISOString(),
      action: String(action || "unknown").slice(0, 80),
      chatId: chatId != null ? String(chatId) : null,
      detail: detail != null ? String(detail).slice(0, 400) : null,
    },
    ADMIN_AUDIT_LIMIT
  );
}

async function readAdminErrors(env) {
  return readJsonList(env, ADMIN_ERRORS_KEY);
}

async function readAdminAudit(env) {
  return readJsonList(env, ADMIN_AUDIT_KEY);
}

export {
  recordAdminError,
  recordAdminAudit,
  readAdminErrors,
  readAdminAudit,
};
