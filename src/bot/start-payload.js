import {
  CALLBACK_STORE_PREFIX,
  MAX_START_PAYLOAD_BYTES,
  getJobStore,
  putKv,
} from "../config.js";
import { makeCallbackData, resolveCallbackData, utf8ByteLength } from "./callback-store.js";

function isSafeStartToken(value) {
  return /^[A-Za-z0-9_-]+$/.test(String(value || ""));
}

async function makeStartPayload(env, type, value) {
  const raw = `${type}_${value}`;
  if (isSafeStartToken(raw) && utf8ByteLength(raw) <= MAX_START_PAYLOAD_BYTES) {
    return raw;
  }

  // Reuse callback KV store; Telegram start payloads cannot include ":".
  const callback = await makeCallbackData(env, type, value);
  if (callback.startsWith("c:")) {
    return `c_${callback.slice(2)}`;
  }

  const kv = getJobStore(env);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  if (kv) {
    try {
      await putKv(kv, `${CALLBACK_STORE_PREFIX}:${id}`, JSON.stringify({ type, value }), {
        expirationTtl: 60 * 60,
      });
      return `c_${id}`;
    } catch (err) {
      console.warn(`Failed to store start payload: ${err.message}`);
    }
  }

  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_START_PAYLOAD_BYTES);
}

async function resolveStartPayload(env, payload) {
  const raw = String(payload || "").trim();
  if (!raw) {
    return null;
  }

  if (raw.startsWith("c_")) {
    return resolveCallbackData(env, `c:${raw.slice(2)}`);
  }

  // Legacy / accidental colon form from older deep links.
  if (raw.includes(":")) {
    return resolveCallbackData(env, raw);
  }

  const idx = raw.indexOf("_");
  if (idx <= 0) {
    return null;
  }
  return { type: raw.slice(0, idx), value: raw.slice(idx + 1) };
}

async function getBotUsername(env) {
  if (env.BOT_USERNAME?.trim()) {
    return env.BOT_USERNAME.trim().replace(/^@/, "");
  }
  const token = env.BOT_TOKEN?.trim();
  if (!token) {
    return null;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const result = await response.json();
    return result?.result?.username || null;
  } catch (err) {
    console.warn(`getMe failed: ${err.message}`);
    return null;
  }
}

async function buildBotStartLink(env, type, value) {
  const username = await getBotUsername(env);
  if (!username) {
    return null;
  }
  const payload = await makeStartPayload(env, type, value);
  return `https://t.me/${username}?start=${payload}`;
}

export { makeStartPayload, resolveStartPayload, getBotUsername, buildBotStartLink };
