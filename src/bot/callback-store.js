import {
  CALLBACK_STORE_PREFIX,
  MAX_CALLBACK_BYTES,
  getJobStore,
  putKv,
} from "../config.js";

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).length;
}

async function makeCallbackData(env, type, value) {
  const raw = `${type}:${value}`;
  if (utf8ByteLength(raw) <= MAX_CALLBACK_BYTES) {
    return raw;
  }
  const kv = getJobStore(env);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  if (kv) {
    try {
      await putKv(kv, `${CALLBACK_STORE_PREFIX}:${id}`, JSON.stringify({ type, value }), {
        expirationTtl: 60 * 60,
      });
    } catch (err) {
      console.warn(`Failed to store long callback payload: ${err.message}`);
      return raw.slice(0, MAX_CALLBACK_BYTES);
    }
  }
  return `c:${id}`;
}

async function resolveCallbackData(env, data) {
  if (!data) {
    return null;
  }
  if (data.startsWith("c:")) {
    const kv = getJobStore(env);
    if (!kv) {
      return null;
    }
    try {
      const raw = await kv.get(`${CALLBACK_STORE_PREFIX}:${data.slice(2)}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  const idx = data.indexOf(":");
  if (idx <= 0) {
    return null;
  }
  return { type: data.slice(0, idx), value: data.slice(idx + 1) };
}

export { utf8ByteLength, makeCallbackData, resolveCallbackData };
