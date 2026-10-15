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

const CALLBACK_STORE_PREFIX = "tg-cb:v1";

const RATE_LIMIT_FALLBACK_SECONDS = 5;

const MAX_RECENT_ITEMS = 5;

const MAX_SEARCH_ARTISTS = 5;

const MAX_SEARCH_SONGS = 8;

const MAX_CALLBACK_BYTES = 64;

function getBotToken(env) {
  return env.BOT_TOKEN?.trim() || "";
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

function shouldCacheArtistUploads(env) {
  return getEnvBoolean(env, "ENABLE_BULK_CACHE_WRITES", false);
}

function getArtistQueueDelaySeconds(env) {
  return Math.min(getEnvNumber(env, "ARTIST_QUEUE_DELAY_SECONDS", 2), 60);
}

function getMaxAudioUrlAttempts(env) {
  return Math.min(getEnvNumber(env, "MAX_AUDIO_URL_ATTEMPTS", DEFAULT_MAX_AUDIO_URL_ATTEMPTS), 8);
}

function getArtistProgressEvery(env) {
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
  CALLBACK_STORE_PREFIX,
  RATE_LIMIT_FALLBACK_SECONDS,
  MAX_RECENT_ITEMS,
  MAX_SEARCH_ARTISTS,
  MAX_SEARCH_SONGS,
  MAX_CALLBACK_BYTES,
  getBotToken,
  getEnvString,
  getEnvBoolean,
  getEnvNumber,
  shouldCacheArtistUploads,
  getArtistQueueDelaySeconds,
  getMaxAudioUrlAttempts,
  getArtistProgressEvery,
  getAdminUserIds,
  isAdminUser,
  queueChatActiveKey,
  queueChatPendingKey,
  queueChatCancelKey,
  userRecentKey,
  getJobStore,
  getFileCacheStore,
  KvWriteLimitError,
  isKvWriteLimitError,
  putKv,
};
