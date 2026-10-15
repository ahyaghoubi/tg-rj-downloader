const RJ_DEFAULTS = {
  API_KEY: "40e87948bd4ef75efe61205ac5f468a9fd2b970511acf58c49706ecb984f1d67",
  USER_AGENT:
    "Radio Javan/4.0.2/f6173917bde5c0102c894b5d2e478693c9d750b7 com.radioJavan.rj.web",
  BROWSER_UA:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ORIGIN: "https://play.radiojavan.com",
};

const MEDIA_HOSTS = [
  "host1.rj-mw1.com",
  "host1.rjapp-content.app",
  "host2.rjapp-content.app",
  "host2.rj-mw1.com",
];

const FALLBACK_HOST_LIMIT = 2;

const MEDIA_PATH_TEMPLATES = {
  song: [
    ["media/mp3/mp3-320", "mp3"],
    ["media/mp3/mp3-256", "mp3"],
  ],
};

const ARTIST_DELIVERY_QUEUE_NAME = "telegram-radiojavan-artist-delivery";

const ARTIST_DELIVERY_DLQ_NAME = "telegram-radiojavan-artist-delivery-dlq";

const QUEUE_CHAT_ACTIVE_PREFIX = "artist-queue-active:v1";

const QUEUE_CHAT_PENDING_PREFIX = "artist-queue-pending:v1";

const QUEUE_CHAT_CANCEL_PREFIX = "artist-queue-cancel:v1";

const QUEUE_CHAT_ACTIVE_TTL_S = 60 * 60;

const DEFAULT_MAX_AUDIO_URL_ATTEMPTS = 3;

const MEDIA_PROBE_TIMEOUT_MS = 4_000;

const MEDIA_DOWNLOAD_TIMEOUT_MS = 25_000;

const MIN_FILE_SIZE = 100;

const FILE_CACHE_PREFIX = "telegram-file:v1";

const USER_RECENT_PREFIX = "user-recent:v1";

const USER_PROFILE_PREFIX = "user:v1";

const ADMIN_USER_INDEX_KEY = "admin-user-index:v1";

const ADMIN_DLQ_EVENTS_KEY = "admin-dlq-events:v1";

const ADMIN_STATS_PREFIX = "stats:v1:daily";

const CALLBACK_STORE_PREFIX = "tg-cb:v1";

const ADMIN_COOKIE_NAME = "rj_admin_session";

const ADMIN_SESSION_TTL_S = 12 * 60 * 60;

const ADMIN_USER_INDEX_LIMIT = 100;

const ADMIN_DLQ_EVENTS_LIMIT = 40;

const ADMIN_ERRORS_KEY = "admin-errors:v1";

const ADMIN_AUDIT_KEY = "admin-audit:v1";

const ADMIN_RUNTIME_CONFIG_KEY = "admin-runtime-config:v1";

const ADMIN_ERRORS_LIMIT = 40;

const ADMIN_AUDIT_LIMIT = 50;

const DEFAULT_DAILY_DOWNLOAD_LIMIT = 80;

const RUNTIME_CONFIG_CACHE = Symbol.for("rj.runtimeConfig");

const RATE_LIMIT_FALLBACK_SECONDS = 5;

const MAX_RECENT_ITEMS = 5;

const MAX_SEARCH_ARTISTS = 5;

const MAX_SEARCH_SONGS = 8;

const MAX_SEARCH_PLAYLISTS = 5;

const MAX_ARTIST_PLAYLIST_BUTTONS = 8;

const ARTIST_LATEST_OPTIONS = [10, 25];

const MAX_CALLBACK_BYTES = 64;

const MAX_START_PAYLOAD_BYTES = 64;

function getBotToken(env) {
  return env.BOT_TOKEN?.trim() || "";
}

function getAdminToken(env) {
  return env.ADMIN_TOKEN?.trim() || "";
}

function getRuntimeConfigCache(env) {
  return env?.[RUNTIME_CONFIG_CACHE] || null;
}

function getDefaultDailyDownloadLimit(env) {
  const runtime = getRuntimeConfigCache(env);
  if (runtime?.defaultDailyDownloadLimit != null) {
    return Math.min(Math.max(0, Number(runtime.defaultDailyDownloadLimit) || 0), 5000);
  }
  return Math.min(getEnvNumber(env, "DEFAULT_DAILY_DOWNLOAD_LIMIT", DEFAULT_DAILY_DOWNLOAD_LIMIT), 5000);
}

function getEnvString(env, key, fallback = "") {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getEnvBoolean(env, key, fallback = false) {
  const value = env[key];
  if (typeof value !== "string") {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function getEnvNumber(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getArtistQueueDelaySeconds(env) {
  const runtime = getRuntimeConfigCache(env);
  if (runtime?.artistQueueDelaySeconds != null) {
    return Math.min(Math.max(1, Number(runtime.artistQueueDelaySeconds) || 1), 60);
  }
  return Math.min(getEnvNumber(env, "ARTIST_QUEUE_DELAY_SECONDS", 2), 60);
}

function getMaxAudioUrlAttempts(env) {
  const runtime = getRuntimeConfigCache(env);
  if (runtime?.maxAudioUrlAttempts != null) {
    return Math.min(Math.max(1, Number(runtime.maxAudioUrlAttempts) || 1), 8);
  }
  return Math.min(getEnvNumber(env, "MAX_AUDIO_URL_ATTEMPTS", DEFAULT_MAX_AUDIO_URL_ATTEMPTS), 8);
}

function getArtistProgressEvery(env) {
  const runtime = getRuntimeConfigCache(env);
  if (runtime?.artistProgressEvery != null) {
    return Math.min(Math.max(1, Number(runtime.artistProgressEvery) || 1), 50);
  }
  return Math.min(getEnvNumber(env, "ARTIST_PROGRESS_EVERY", 5), 50);
}

function getAdminUserIds(env) {
  return getEnvString(env, "ADMIN_USER_IDS", "")
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function isAdminUser(env, userId) {
  return getAdminUserIds(env).includes(String(userId));
}

function queueChatActiveKey(chatId) {
  return `${QUEUE_CHAT_ACTIVE_PREFIX}:${chatId}`;
}

function queueChatPendingKey(chatId) {
  return `${QUEUE_CHAT_PENDING_PREFIX}:${chatId}`;
}

function queueChatCancelKey(chatId) {
  return `${QUEUE_CHAT_CANCEL_PREFIX}:${chatId}`;
}

function userRecentKey(chatId) {
  return `${USER_RECENT_PREFIX}:${chatId}`;
}

function userKey(chatId) {
  return `${USER_PROFILE_PREFIX}:${chatId}`;
}

function getJobStore(env) {
  return env.ARTIST_JOB_STORE || null;
}

function getFileCacheStore(env) {
  return env.TELEGRAM_FILE_CACHE || null;
}

class KvWriteLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "KvWriteLimitError";
  }
}

function isKvWriteLimitError(err) {
  const message = String(err?.message || err || "");
  return /429|limit|quota/i.test(message);
}

async function putKv(kv, key, value, options) {
  try {
    if (options) {
      await kv.put(key, value, options);
      return;
    }
    await kv.put(key, value);
  } catch (err) {
    if (isKvWriteLimitError(err)) {
      throw new KvWriteLimitError(`Cloudflare KV write limit reached while writing ${key}`);
    }
    throw err;
  }
}

export {
  RJ_DEFAULTS,
  MEDIA_HOSTS,
  FALLBACK_HOST_LIMIT,
  MEDIA_PATH_TEMPLATES,
  ARTIST_DELIVERY_QUEUE_NAME,
  ARTIST_DELIVERY_DLQ_NAME,
  QUEUE_CHAT_ACTIVE_PREFIX,
  QUEUE_CHAT_PENDING_PREFIX,
  QUEUE_CHAT_CANCEL_PREFIX,
  QUEUE_CHAT_ACTIVE_TTL_S,
  DEFAULT_MAX_AUDIO_URL_ATTEMPTS,
  MEDIA_PROBE_TIMEOUT_MS,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  MIN_FILE_SIZE,
  FILE_CACHE_PREFIX,
  USER_RECENT_PREFIX,
  USER_PROFILE_PREFIX,
  ADMIN_USER_INDEX_KEY,
  ADMIN_DLQ_EVENTS_KEY,
  ADMIN_STATS_PREFIX,
  ADMIN_ERRORS_KEY,
  ADMIN_AUDIT_KEY,
  ADMIN_RUNTIME_CONFIG_KEY,
  ADMIN_ERRORS_LIMIT,
  ADMIN_AUDIT_LIMIT,
  DEFAULT_DAILY_DOWNLOAD_LIMIT,
  RUNTIME_CONFIG_CACHE,
  CALLBACK_STORE_PREFIX,
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_S,
  ADMIN_USER_INDEX_LIMIT,
  ADMIN_DLQ_EVENTS_LIMIT,
  RATE_LIMIT_FALLBACK_SECONDS,
  MAX_RECENT_ITEMS,
  MAX_SEARCH_ARTISTS,
  MAX_SEARCH_SONGS,
  MAX_SEARCH_PLAYLISTS,
  MAX_ARTIST_PLAYLIST_BUTTONS,
  ARTIST_LATEST_OPTIONS,
  MAX_CALLBACK_BYTES,
  MAX_START_PAYLOAD_BYTES,
  getBotToken,
  getAdminToken,
  getDefaultDailyDownloadLimit,
  getEnvString,
  getEnvBoolean,
  getEnvNumber,
  getArtistQueueDelaySeconds,
  getMaxAudioUrlAttempts,
  getArtistProgressEvery,
  getAdminUserIds,
  isAdminUser,
  queueChatActiveKey,
  queueChatPendingKey,
  queueChatCancelKey,
  userRecentKey,
  userKey,
  getJobStore,
  getFileCacheStore,
  KvWriteLimitError,
  isKvWriteLimitError,
  putKv,
};
