import {
  ADMIN_RUNTIME_CONFIG_KEY,
  RUNTIME_CONFIG_CACHE,
  getJobStore,
  putKv,
  getArtistQueueDelaySeconds,
  getArtistProgressEvery,
  getMaxAudioUrlAttempts,
  getDefaultDailyDownloadLimit,
} from "../config.js";

function emptyRuntimeConfig() {
  return {
    queuePaused: false,
    artistQueueDelaySeconds: null,
    artistProgressEvery: null,
    maxAudioUrlAttempts: null,
    defaultDailyDownloadLimit: null,
    updatedAt: null,
  };
}

function normalizeRuntimeConfig(parsed = {}) {
  const base = emptyRuntimeConfig();
  const numOrNull = (value) => {
    if (value == null || value === "") {
      return null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  return {
    ...base,
    queuePaused: Boolean(parsed.queuePaused),
    artistQueueDelaySeconds: numOrNull(parsed.artistQueueDelaySeconds),
    artistProgressEvery: numOrNull(parsed.artistProgressEvery),
    maxAudioUrlAttempts: numOrNull(parsed.maxAudioUrlAttempts),
    defaultDailyDownloadLimit: numOrNull(parsed.defaultDailyDownloadLimit),
    updatedAt: parsed.updatedAt || null,
  };
}

async function loadRuntimeConfig(env, { force = false } = {}) {
  if (!force && env?.[RUNTIME_CONFIG_CACHE]) {
    return env[RUNTIME_CONFIG_CACHE];
  }
  const kv = getJobStore(env);
  let config = emptyRuntimeConfig();
  if (kv) {
    try {
      const raw = await kv.get(ADMIN_RUNTIME_CONFIG_KEY);
      if (raw) {
        config = normalizeRuntimeConfig(JSON.parse(raw));
      }
    } catch (err) {
      console.warn(`loadRuntimeConfig failed: ${err.message}`);
    }
  }
  if (env) {
    env[RUNTIME_CONFIG_CACHE] = config;
  }
  return config;
}

async function saveRuntimeConfig(env, patch = {}) {
  const current = await loadRuntimeConfig(env, { force: true });
  const next = normalizeRuntimeConfig({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  const kv = getJobStore(env);
  if (!kv) {
    throw new Error("ARTIST_JOB_STORE missing");
  }
  await putKv(kv, ADMIN_RUNTIME_CONFIG_KEY, JSON.stringify(next));
  env[RUNTIME_CONFIG_CACHE] = next;
  return next;
}

function isQueuePaused(env) {
  return Boolean(env?.[RUNTIME_CONFIG_CACHE]?.queuePaused);
}

function effectiveConfigSnapshot(env) {
  const runtime = env?.[RUNTIME_CONFIG_CACHE] || emptyRuntimeConfig();
  return {
    queuePaused: Boolean(runtime.queuePaused),
    artistQueueDelaySeconds: getArtistQueueDelaySeconds(env),
    artistProgressEvery: getArtistProgressEvery(env),
    maxAudioUrlAttempts: getMaxAudioUrlAttempts(env),
    defaultDailyDownloadLimit: getDefaultDailyDownloadLimit(env),
    overrides: {
      artistQueueDelaySeconds: runtime.artistQueueDelaySeconds,
      artistProgressEvery: runtime.artistProgressEvery,
      maxAudioUrlAttempts: runtime.maxAudioUrlAttempts,
      defaultDailyDownloadLimit: runtime.defaultDailyDownloadLimit,
    },
    updatedAt: runtime.updatedAt,
  };
}

export {
  emptyRuntimeConfig,
  loadRuntimeConfig,
  saveRuntimeConfig,
  isQueuePaused,
  effectiveConfigSnapshot,
};
