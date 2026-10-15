export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/internal/run-artist-job") {
        const secret = env.JOB_RUNNER_SECRET;
        if (!secret || getBearerToken(request) !== secret) {
          return new Response("Forbidden", { status: 403 });
        }

        const jobId = url.searchParams.get("id");
        if (!jobId) {
          return new Response("Missing 'id' parameter", { status: 400 });
        }

        ctx.waitUntil(runArtistJobBatch(env, jobId, url.origin, ctx));
        return new Response("OK", { status: 200 });
      }

      if (url.pathname === "/internal/run-artist-stateless") {
        const secret = env.JOB_RUNNER_SECRET;
        if (!secret || getBearerToken(request) !== secret) {
          return new Response("Forbidden", { status: 403 });
        }

        const payload = await request.json();
        ctx.waitUntil(runStatelessArtistBatch(env, payload, url.origin));
        return new Response("OK", { status: 200 });
      }

      if (url.pathname === "/internal/warm-artist") {
        const secret = env.JOB_RUNNER_SECRET;
        if (!secret || getBearerToken(request) !== secret) {
          return new Response("Forbidden", { status: 403 });
        }

        let chatId = url.searchParams.get("chatId") || url.searchParams.get("userid");
        let artistName = url.searchParams.get("artist") || url.searchParams.get("artistName");
        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          chatId = body.chatId || body.userid || chatId;
          artistName = body.artistName || body.artist || artistName;
        }

        if (!chatId || !artistName) {
          return new Response("Missing chatId/userid or artistName/artist", { status: 400 });
        }
        if (!env.ARTIST_QUEUE) {
          return new Response("ARTIST_QUEUE is not configured", { status: 500 });
        }

        ctx.waitUntil(warmArtistMissingTracks(env, String(chatId), String(artistName)));
        return jsonResponse({
          ok: true,
          mode: "warm-missing-only",
          chatId: String(chatId),
          artistName: String(artistName),
        });
      }

      if (request.method === "POST" && url.pathname === "/webhook") {
        const token = getBotToken(env);
        if (!token) {
          console.error("BOT_TOKEN is not configured");
          return new Response("BOT_TOKEN not configured", { status: 500 });
        }

        const update = await request.json();
        ctx.waitUntil(processUpdate(update, env, url.origin));
        return new Response("OK", { status: 200 });
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return handleHealth(env);
      }

      if (request.method === "GET" && url.pathname === "/") {
        const link = url.searchParams.get("link");
        const userid = url.searchParams.get("userid");

        if (!link && !userid) {
          return new Response("Cloudflare Worker for Telegram Bot is running!", {
            status: 200,
          });
        }

        if (!link || !userid) {
          return new Response("Missing 'link' or 'userid' parameter", { status: 400 });
        }

        if (!getBotToken(env)) {
          return new Response("BOT_TOKEN not configured", { status: 500 });
        }

        ctx.waitUntil(handleUrl(userid, link, env, url.origin));
        return new Response("File processing initiated", { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(`Error: ${err.message}`);
      return new Response("Error: Unable to process your request.", {
        status: 500,
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWatchdog(env, ctx));
  },

  async queue(batch, env, ctx) {
    if (batch.queue === ARTIST_DELIVERY_DLQ_NAME) {
      for (const message of batch.messages) {
        try {
          await handleArtistDeliveryDlq(env, message.body);
        } catch (err) {
          console.error(`Artist delivery DLQ handling failed: ${err.message}`);
        }
        message.ack();
      }
      return;
    }

    for (const message of batch.messages) {
      try {
        await runQueuedArtistMessage(env, message.body);
        message.ack();
      } catch (err) {
        if (err instanceof TelegramRateLimitError) {
          const payload = normalizeQueuePayload(message.body) || {};
          const boost = Math.min(
            Number(payload.rateLimitBoost || 0) + Math.max(2, Math.ceil((err.retryAfter || 5) / 2)),
            30
          );
          payload.rateLimitBoost = boost;
          const delaySeconds = Math.max(
            err.retryAfter || RATE_LIMIT_FALLBACK_SECONDS,
            getArtistQueueDelaySeconds(env) + boost,
            1
          );
          console.warn(
            `Queue artist delivery rate limited; requeue with boost=${boost} delay=${delaySeconds}s`
          );
          try {
            await enqueueArtistQueueMessage(env, payload, { delaySeconds });
            message.ack();
          } catch (enqueueErr) {
            console.warn(`Rate-limit requeue failed: ${enqueueErr.message}`);
            message.retry({ delaySeconds });
          }
          continue;
        }

        console.error(`Queue artist delivery failed: ${err.message}`);
        message.retry();
      }
    }
  },
};

const RJ_DEFAULTS = {
  API_KEY: "40e87948bd4ef75efe61205ac5f468a9fd2b970511acf58c49706ecb984f1d67",
  USER_AGENT:
    "Radio Javan/4.0.2/f6173917bde5c0102c894b5d2e478693c9d750b7 com.radioJavan.rj.web",
  BROWSER_UA:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ORIGIN: "https://play.radiojavan.com",
};

// Prefer hosts that Telegram can fetch reliably; host2.rj-mw1.com often fails URL send.
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
const QUEUE_CHAT_ACTIVE_TTL_S = 60 * 60;
const DEFAULT_MAX_AUDIO_URL_ATTEMPTS = 3;
const MEDIA_PROBE_TIMEOUT_MS = 4_000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 25_000;

function upgradeTo320Url(url) {
  if (typeof url !== "string" || /mp3-320/i.test(url)) {
    return null;
  }
  if (/mp3-256/i.test(url)) {
    return url.replace("/mp3-256/", "/mp3-320/");
  }
  return null;
}

function getMp3QualityRank(url) {
  if (/mp3-320/i.test(url)) {
    return 0;
  }
  if (/mp3-256/i.test(url)) {
    return 1;
  }
  if (/\.mp3(\?|$)/i.test(url)) {
    return 2;
  }
  if (/aac-256/i.test(url)) {
    return 3;
  }
  if (/aac-128/i.test(url)) {
    return 4;
  }
  return 5;
}

function orderSongUrls(urls) {
  return [...new Set(urls)].sort((a, b) => getMp3QualityRank(a) - getMp3QualityRank(b));
}

function collectRawUrlsFromTrack(track) {
  const urls = [];
  for (const key of ["link", "hq_link", "lq_link"]) {
    const value = track[key];
    if (typeof value === "string" && value.startsWith("http") && !urls.includes(value)) {
      urls.push(value);
    }
  }
  return urls;
}

function resolveSongUrls(mediaType, permlink, apiUrls = []) {
  const candidates = [];

  const push = (url) => {
    if (typeof url === "string" && url.startsWith("http") && !candidates.includes(url)) {
      candidates.push(url);
    }
  };

  for (const url of apiUrls) {
    const upgraded = upgradeTo320Url(url);
    if (upgraded) {
      push(upgraded);
    }
    push(url);
  }

  // Prefer API URLs only when present. Constructed CDN fallbacks are a last resort
  // because Telegram often rejects some hosts for URL fetch.
  if (candidates.length === 0) {
    for (const url of buildFallbackUrls(mediaType, permlink)) {
      push(url);
    }
  }

  return orderSongUrls(candidates);
}

const API_MEDIA_TYPES = {
  song: "mp3",
};

function isSupportedMediaType(mediaType) {
  return mediaType === "song";
}

function isSkippedTrack(item) {
  if (item?.type === "video" || item?.type === "podcast") {
    return true;
  }

  for (const key of ["link", "hq_link", "lq_link"]) {
    const value = item?.[key];
    if (typeof value !== "string") {
      continue;
    }
    if (/\.mp4(\?|$)/i.test(value) || /music_video/i.test(value)) {
      return true;
    }
    if (/\/podcast\//i.test(value)) {
      return true;
    }
  }

  return false;
}

const MIN_FILE_SIZE = 100;

const FILE_CACHE_PREFIX = "telegram-file:v1";
const JOB_PREFIX = "artist-job:v1";
const CHAT_ACTIVE_PREFIX = "artist-job-active:v1";
const CHAT_QUEUED_PREFIX = "artist-job-queued:v1";
const QUEUE_CHAT_CANCEL_PREFIX = "artist-queue-cancel:v1";
const USER_RECENT_PREFIX = "user-recent:v1";
const CALLBACK_STORE_PREFIX = "tg-cb:v1";
const ACTIVE_INDEX_KEY = "artist-jobs-active:v1";
const QUEUE_INDEX_KEY = "artist-jobs-queued:v1";
const WORKER_ORIGIN_KEY = "meta:v1:worker-origin";

const ARTIST_BATCH_SIZE = 1;
const MAX_GLOBAL_ACTIVE_JOBS = 5;
const MAX_TRACK_ATTEMPTS = 2;
const JOB_LOCK_LEASE_MS = 90_000;
const JOB_RUN_TIME_BUDGET_MS = 8_000;
const RATE_LIMIT_FALLBACK_SECONDS = 5;
const COMPLETED_JOB_TTL_S = 24 * 60 * 60;
const WATCHDOG_MAX_JOBS = 3;
const MAX_RECENT_ITEMS = 5;
const MAX_SEARCH_ARTISTS = 5;
const MAX_SEARCH_SONGS = 8;
const MAX_CALLBACK_BYTES = 64;
const HELP_TEXT = `دستورهای ربات دانلود رادیو جوان:

/start — خوش‌آمدگویی
/help — همین راهنما
/search <عبارت> — جستجوی آهنگ و خواننده
/recent — آخرین جستجوها و دانلودها
/cancel — توقف ارسال آلبوم/خوانندهٔ در حال انجام
/status — وضعیت ادمین (فقط ادمین‌ها)

همچنین می‌توانید:
• لینک آهنگ یا خوانندهٔ رادیو جوان را بفرستید
• بدون /search فقط عبارت جستجو را بنویسید
• از حالت اینلاین استفاده کنید: @yourbot <عبارت>`;

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

function getArtistDeliveryMode(env) {
  return getEnvString(env, "ARTIST_DELIVERY_MODE", "queue").toLowerCase();
}

function shouldCacheArtistUploads(env) {
  return getEnvBoolean(env, "ENABLE_BULK_CACHE_WRITES", false);
}

function getMaxActiveArtistJobs(env) {
  return getEnvNumber(env, "MAX_ACTIVE_ARTIST_JOBS", MAX_GLOBAL_ACTIVE_JOBS);
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

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).length;
}

function parseBotCommand(text) {
  if (!text || !text.startsWith("/")) {
    return null;
  }
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].slice(1).toLowerCase();
  return { name: cmd, arg: rest.join(" ").trim() };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleHealth(env) {
  const token = getBotToken(env);
  if (!token) {
    return jsonResponse({ ok: false, error: "BOT_TOKEN not configured" }, 500);
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const result = await response.json();

  return jsonResponse(
    {
      ok: result.ok,
      bot: result.result?.username || null,
      error: result.ok ? null : result.description,
      artistQueue: ARTIST_DELIVERY_QUEUE_NAME,
      artistDlq: ARTIST_DELIVERY_DLQ_NAME,
      bulkCacheWrites: shouldCacheArtistUploads(env),
      maxAudioUrlAttempts: getMaxAudioUrlAttempts(env),
      ops: {
        inspectDlq: `npx wrangler tail && watch ${ARTIST_DELIVERY_DLQ_NAME}`,
        warmArtist: "POST /internal/warm-artist with Bearer JOB_RUNNER_SECRET",
        note: "Do not try to cache the entire Radio Javan catalog on the free KV write quota (~1000 writes/day).",
      },
    },
    result.ok ? 200 : 500
  );
}

function normalizeInput(text) {
  const trimmed = text.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^(?:www\.)?(?:play\.)?radiojavan\.com\//i.test(trimmed) || /^rj\.app\//i.test(trimmed)) {
    return `https://${trimmed.replace(/^\/+/, "")}`;
  }
  return trimmed;
}

function extractLinkFromMessage(message) {
  if (!message?.text) {
    return null;
  }

  if (message.entities) {
    for (const entity of message.entities) {
      if (entity.type === "url") {
        return normalizeInput(message.text.slice(entity.offset, entity.offset + entity.length));
      }
    }
  }

  const urlMatch = message.text.match(/(?:https?:\/\/|(?:www\.)?(?:play\.)?radiojavan\.com\/|rj\.app\/)\S+/i);
  if (urlMatch) {
    return normalizeInput(urlMatch[0]);
  }

  const normalized = normalizeInput(message.text);
  if (
    normalized.startsWith("http") ||
    normalized.includes("radiojavan.com") ||
    normalized.startsWith("rj.app")
  ) {
    return normalized;
  }

  return null;
}

function getRjCredentials(env) {
  return {
    apiKey: env.RJ_API_KEY || RJ_DEFAULTS.API_KEY,
    userAgent: env.RJ_USER_AGENT || RJ_DEFAULTS.USER_AGENT,
  };
}

function getRadioJavanApiHeaders(env, refererPath) {
  const { apiKey, userAgent } = getRjCredentials(env);
  return {
    "User-Agent": RJ_DEFAULTS.BROWSER_UA,
    Referer: `${RJ_DEFAULTS.ORIGIN}${refererPath}`,
    Origin: RJ_DEFAULTS.ORIGIN,
    Accept: "application/json, text/plain, */*",
    "x-api-key": apiKey,
    "x-rj-user-agent": userAgent,
  };
}

function parseMediaFromUrl(link) {
  const parsed = new URL(link);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`Invalid URL format: ${link}`);
  }
  return {
    mediaType: segments[0],
    mediaName: segments[1],
  };
}

function extractArtistName(link) {
  const { mediaName } = parseMediaFromUrl(link);
  return mediaName;
}

function buildFallbackUrls(mediaType, permlink) {
  const templates = MEDIA_PATH_TEMPLATES[mediaType];
  if (!templates) {
    return [];
  }

  const names = [permlink];
  const lower = permlink.toLowerCase();
  if (lower !== permlink) {
    names.push(lower);
  }

  const urls = [];
  const hosts = MEDIA_HOSTS.slice(0, FALLBACK_HOST_LIMIT);
  for (const [hostIndex, host] of hosts.entries()) {
    for (const [path, ext] of templates) {
      // Only the primary host tries alternate permlink casing.
      const nameList = hostIndex === 0 ? names : [permlink];
      for (const name of nameList) {
        const url = `https://${host}/${path}/${name}.${ext}`;
        if (!urls.includes(url)) {
          urls.push(url);
        }
      }
    }
  }
  return urls;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isTelegramUrlContentError(err) {
  return /failed to get HTTP URL content/i.test(String(err?.message || err || ""));
}

function trackFromApiItem(item, mediaType) {
  if (!item?.permlink) {
    return null;
  }

  const rawUrls = collectRawUrlsFromTrack(item);
  return {
    permlink: item.permlink,
    title: item.title || item.song || item.permlink,
    mediaType,
    urls: resolveSongUrls(mediaType, item.permlink, rawUrls),
  };
}

function extractTracksFromPayload(data) {
  const tracks = [];
  const seen = new Set();

  const visit = (obj) => {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        visit(item);
      }
      return;
    }

    if (!obj || typeof obj !== "object") {
      return;
    }

    const hasDirectLink = Boolean(obj.link || obj.hq_link || obj.lq_link);
    if (typeof obj.permlink === "string" && hasDirectLink && !isSkippedTrack(obj)) {
      const key = obj.permlink.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        tracks.push(trackFromApiItem(obj, "song"));
      }
    }

    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        visit(value);
      }
    }
  };

  visit(data);
  return tracks;
}

async function fetchRadioJavanApi(env, endpoint, refererPath) {
  const response = await fetch(`${RJ_DEFAULTS.ORIGIN}${endpoint}`, {
    method: "GET",
    headers: getRadioJavanApiHeaders(env, refererPath),
  });

  if (!response.ok) {
    throw new Error(`Non-OK HTTP status: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchArtistTracks(env, artistName) {
  const refererPath = `/artist/${artistName}/songs`;
  const endpoints = [
    `/api/p/artist?query=${encodeURIComponent(artistName)}&v=2`,
    `/api/p/artist?query=${encodeURIComponent(artistName)}`,
  ];

  let lastError;
  for (const endpoint of endpoints) {
    try {
      const data = await fetchRadioJavanApi(env, endpoint, refererPath);
      const tracks = extractTracksFromPayload(data);
      if (tracks.length) {
        return tracks;
      }
    } catch (err) {
      lastError = err;
      console.warn(`Artist API attempt failed (${endpoint}): ${err.message}`);
    }
  }

  throw lastError || new Error("No tracks found for artist");
}

async function fetchMediaTrack(env, mediaType, permlink) {
  const apiType = API_MEDIA_TYPES[mediaType];
  if (!apiType) {
    return null;
  }

  const refererPath = `/${mediaType}/${permlink}`;
  try {
    const data = await fetchRadioJavanApi(
      env,
      `/api/p/${apiType}?id=${encodeURIComponent(permlink)}`,
      refererPath
    );
    return trackFromApiItem(data, mediaType);
  } catch (err) {
    console.warn(`Metadata API failed for ${mediaType}/${permlink}: ${err.message}`);
    return null;
  }
}

async function resolveDownloadUrls(env, mediaType, permlink, knownUrls = []) {
  const track = await fetchMediaTrack(env, mediaType, permlink);
  const apiUrls = [...knownUrls];
  if (track) {
    for (const url of track.urls) {
      if (!apiUrls.includes(url)) {
        apiUrls.push(url);
      }
    }
  }

  const urls = resolveSongUrls(mediaType, permlink, apiUrls);
  return { urls, title: track?.title || permlink };
}

async function isValidMediaUrl(url) {
  const headers = {
    "User-Agent": RJ_DEFAULTS.BROWSER_UA,
    Accept: "*/*",
  };

  try {
    const signal = AbortSignal.timeout(MEDIA_PROBE_TIMEOUT_MS);
    let response = await fetch(url, { method: "HEAD", headers, redirect: "follow", signal });
    if (!response.ok) {
      response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(MEDIA_PROBE_TIMEOUT_MS),
      });
    }

    if (!response.ok) {
      return false;
    }

    const length = Number(response.headers.get("content-length") || 0);
    if (length > 0 && length < MIN_FILE_SIZE) {
      return false;
    }

    if (response.body) {
      await response.body.cancel();
    }
    return true;
  } catch (err) {
    console.warn(`Validation failed for ${url}: ${err.message}`);
    return false;
  }
}

async function fetchFileAsBlob(urls, { deadHosts = null, maxAttempts = DEFAULT_MAX_AUDIO_URL_ATTEMPTS, validate = false } = {}) {
  let attempts = 0;
  for (const url of urls) {
    if (attempts >= maxAttempts) {
      break;
    }

    const host = hostnameOf(url);
    if (host && deadHosts?.has(host)) {
      continue;
    }

    attempts += 1;
    try {
      if (validate && !(await isValidMediaUrl(url))) {
        continue;
      }

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": RJ_DEFAULTS.BROWSER_UA,
          Referer: `${RJ_DEFAULTS.ORIGIN}/`,
          Origin: RJ_DEFAULTS.ORIGIN,
          Accept: "*/*",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.warn(`Failed to fetch from ${url}: HTTP ${response.status}`);
        continue;
      }

      const blob = await response.blob();
      if (blob.size >= MIN_FILE_SIZE) {
        return { blob, url };
      }

      console.warn(`Unusually small file (${blob.size} bytes) from ${url}`);
    } catch (err) {
      console.error(`Error fetching from ${url}: ${err.message}`);
    }
  }

  throw new Error("Failed to fetch file from all provided URLs.");
}

async function sendArtistTracksAsAudio(userId, tracks, env) {
  const token = getBotToken(env);
  let sent = 0;
  const failed = [];

  for (const track of tracks) {
    try {
      await sendTrackToUser(userId, track, env, { preferUrl: true });
      sent++;
    } catch (err) {
      console.error(`Failed to send ${track.permlink}: ${err.message}`);
      failed.push(track.title || track.permlink);
    }
  }

  let summary = `تمام شد. ${sent}/${tracks.length} آهنگ ارسال شد.`;
  if (failed.length) {
    summary += `\n\nارسال نشد:\n${failed.join("\n")}`;
  }
  await sendMessage(userId, summary, token);
}

function getFileExtension(sourceUrl) {
  if (sourceUrl?.includes(".m4a")) {
    return "m4a";
  }
  return "mp3";
}

function getUrlQuality(url) {
  if (/mp3-320/i.test(url)) {
    return "320";
  }
  if (/mp3-256/i.test(url)) {
    return "256";
  }
  if (/aac-256/i.test(url)) {
    return "aac256";
  }
  if (/aac-128/i.test(url)) {
    return "aac128";
  }
  return "other";
}

function groupUrlsByQuality(urls) {
  const groups = new Map();
  for (const url of urls) {
    const quality = getUrlQuality(url);
    if (!groups.has(quality)) {
      groups.set(quality, []);
    }
    groups.get(quality).push(url);
  }

  const ordered = [];
  for (const quality of ["320", "256"]) {
    if (groups.has(quality)) {
      ordered.push({ quality, urls: groups.get(quality) });
      groups.delete(quality);
    }
  }
  for (const [quality, list] of groups) {
    ordered.push({ quality, urls: list });
  }
  return ordered;
}

function stripUrlQuery(url) {
  if (typeof url !== "string") {
    return null;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

function getFileCacheStore(env) {
  return env.TELEGRAM_FILE_CACHE || null;
}

function normalizeCachePermlink(permlink) {
  return String(permlink || "").toLowerCase();
}

function getTelegramFileCacheKey(track, quality) {
  const mediaType = String(track.mediaType || "song").toLowerCase();
  const permlink = normalizeCachePermlink(track.permlink);
  return `${FILE_CACHE_PREFIX}:song:${mediaType}:${permlink}:${quality}`;
}

function getLegacyTelegramFileCacheKeys(track, quality) {
  const mediaType = track.mediaType || "song";
  const permlink = String(track.permlink || "");
  const keys = new Set();
  // Historical keys used the raw permlink casing (and sometimes mixed mediaType casing).
  keys.add(`${FILE_CACHE_PREFIX}:song:${mediaType}:${permlink}:${quality}`);
  if (permlink !== permlink.toLowerCase()) {
    keys.add(`${FILE_CACHE_PREFIX}:song:${mediaType}:${permlink.toLowerCase()}:${quality}`);
  }
  if (mediaType !== mediaType.toLowerCase()) {
    keys.add(`${FILE_CACHE_PREFIX}:song:${mediaType.toLowerCase()}:${permlink}:${quality}`);
  }
  keys.delete(getTelegramFileCacheKey(track, quality));
  return [...keys];
}

async function readCacheRecord(kv, key) {
  const raw = await kv.get(key);
  if (!raw) {
    return null;
  }
  const data = JSON.parse(raw);
  if (!data || typeof data.fileId !== "string" || !data.fileId) {
    await kv.delete(key);
    return null;
  }
  return data;
}

async function getCachedTelegramFile(env, track, quality) {
  const kv = getFileCacheStore(env);
  if (!kv) {
    return null;
  }

  const key = getTelegramFileCacheKey(track, quality);
  try {
    const canonical = await readCacheRecord(kv, key);
    if (canonical) {
      return canonical;
    }

    for (const legacyKey of getLegacyTelegramFileCacheKeys(track, quality)) {
      const legacy = await readCacheRecord(kv, legacyKey);
      if (!legacy) {
        continue;
      }

      // Best-effort migrate to the canonical lowercase key.
      try {
        await putKv(kv, key, JSON.stringify({ ...legacy, permlink: track.permlink, quality }));
        await kv.delete(legacyKey);
        console.log(`Migrated Telegram file cache key ${legacyKey} -> ${key}`);
      } catch (err) {
        if (!(err instanceof KvWriteLimitError)) {
          console.warn(`Cache migrate failed for ${legacyKey}: ${err.message}`);
        }
      }
      return legacy;
    }

    return null;
  } catch (err) {
    console.warn(`Cache read failed for ${key}: ${err.message}`);
    try {
      await kv.delete(key);
    } catch (_) {
      // best effort
    }
    return null;
  }
}

async function cacheTelegramFile(env, track, quality, fileId, sourceUrl) {
  const kv = getFileCacheStore(env);
  if (!kv || !fileId) {
    return;
  }

  const key = getTelegramFileCacheKey(track, quality);
  const record = {
    fileId,
    title: track.title || track.permlink,
    mediaType: track.mediaType,
    permlink: track.permlink,
    quality,
    sourceUrl: stripUrlQuery(sourceUrl),
    fileExtension: getFileExtension(sourceUrl),
    cachedAt: new Date().toISOString(),
  };

  try {
    await putKv(kv, key, JSON.stringify(record));
    console.log(`Cached Telegram file_id for ${key}`);
    for (const legacyKey of getLegacyTelegramFileCacheKeys(track, quality)) {
      try {
        await kv.delete(legacyKey);
      } catch (_) {
        // best effort cleanup of casing duplicates
      }
    }
  } catch (err) {
    if (err instanceof KvWriteLimitError) {
      console.warn(`Skipping Telegram file cache write: ${err.message}`);
      return;
    }
    console.warn(`Cache write failed for ${key}: ${err.message}`);
  }
}

async function deleteCachedTelegramFile(env, track, quality) {
  const kv = getFileCacheStore(env);
  if (!kv) {
    return;
  }

  const keys = [getTelegramFileCacheKey(track, quality), ...getLegacyTelegramFileCacheKeys(track, quality)];
  for (const key of keys) {
    try {
      await kv.delete(key);
    } catch (err) {
      console.warn(`Cache delete failed for ${key}: ${err.message}`);
    }
  }
}

async function isTrackCached(env, track) {
  for (const quality of ["320", "256"]) {
    if (await getCachedTelegramFile(env, track, quality)) {
      return true;
    }
  }
  return false;
}

async function filterUncachedTracks(env, tracks) {
  const missing = [];
  for (const track of tracks) {
    if (!(await isTrackCached(env, track))) {
      missing.push(track);
    }
  }
  return missing;
}

async function sendTrackToUser(
  userId,
  track,
  env,
  { preferUrl = true, cacheUploads = true, maxUrlAttempts = null } = {}
) {
  const token = getBotToken(env);
  const urls = resolveSongUrls(track.mediaType, track.permlink, track.urls);
  if (!urls.length) {
    throw new Error(`No candidate URLs for ${track.permlink}`);
  }

  const attemptLimit = maxUrlAttempts || getMaxAudioUrlAttempts(env);
  const deadHosts = new Set();
  let lastError;

  for (const { quality, urls: qualityUrls } of groupUrlsByQuality(urls)) {
    const cached = await getCachedTelegramFile(env, track, quality);
    if (cached) {
      try {
        await sendAudioByFileId(userId, cached.fileId, token);
        console.log(`Cache hit for ${track.permlink} (${quality})`);
        return;
      } catch (err) {
        if (err instanceof TelegramRateLimitError) {
          throw err;
        }
        console.warn(`Cached file_id rejected for ${track.permlink} (${quality}): ${err.message}`);
        await deleteCachedTelegramFile(env, track, quality);
      }
    }

    if (preferUrl) {
      let urlAttempts = 0;
      for (const audioUrl of qualityUrls) {
        if (urlAttempts >= attemptLimit) {
          break;
        }
        const host = hostnameOf(audioUrl);
        if (host && deadHosts.has(host)) {
          continue;
        }

        urlAttempts += 1;
        try {
          const result = await sendAudioByUrl(userId, audioUrl, token);
          if (cacheUploads) {
            await cacheTelegramFile(env, track, quality, result?.audio?.file_id, audioUrl);
          }
          return;
        } catch (err) {
          if (err instanceof TelegramRateLimitError) {
            throw err;
          }
          lastError = err;
          if (host && isTelegramUrlContentError(err)) {
            deadHosts.add(host);
            console.warn(`Marking host ${host} dead for this send after URL content failure`);
          }
          console.warn(`URL send failed for ${audioUrl}: ${err.message}`);
        }
      }
    }

    try {
      // Telegram URL-content failures do not mean the Worker cannot download the same host.
      const { blob, url: sourceUrl } = await fetchFileAsBlob(qualityUrls, {
        maxAttempts: attemptLimit,
        validate: false,
      });
      const fileName = `${track.permlink}.${getFileExtension(sourceUrl)}`;
      const result = await sendAudio(userId, blob, fileName, token);
      if (cacheUploads) {
        await cacheTelegramFile(env, track, quality, result?.audio?.file_id, sourceUrl);
      }
      return;
    } catch (err) {
      if (err instanceof TelegramRateLimitError) {
        throw err;
      }
      lastError = err;
      console.warn(`Upload failed for ${track.permlink} (${quality}): ${err.message}`);
    }
  }

  throw lastError || new Error(`Could not send ${track.permlink}`);
}

function getJobStore(env) {
  return env.ARTIST_JOB_STORE || null;
}

function artistJobsEnabled(env) {
  return Boolean(getJobStore(env) && env.JOB_RUNNER_SECRET);
}

function getBearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function chatActiveKey(chatId) {
  return `${CHAT_ACTIVE_PREFIX}:${chatId}`;
}

function chatQueuedKey(chatId) {
  return `${CHAT_QUEUED_PREFIX}:${chatId}`;
}

function isActiveStatus(status) {
  return status === "pending" || status === "running";
}

async function readJsonArray(kv, key) {
  try {
    const raw = await kv.get(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`Failed to read index ${key}: ${err.message}`);
    return [];
  }
}

async function writeJsonArray(kv, key, arr) {
  try {
    await putKv(kv, key, JSON.stringify(arr));
  } catch (err) {
    console.warn(`Failed to write index ${key}: ${err.message}`);
  }
}

async function addToIndex(kv, key, jobId) {
  const arr = await readJsonArray(kv, key);
  if (!arr.includes(jobId)) {
    arr.push(jobId);
    await writeJsonArray(kv, key, arr);
  }
}

async function removeFromIndex(kv, key, jobId) {
  const arr = await readJsonArray(kv, key);
  const next = arr.filter((id) => id !== jobId);
  if (next.length !== arr.length) {
    await writeJsonArray(kv, key, next);
  }
}

function createJobRecord(chatId, artistName, tracks) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    chatId,
    artistName,
    tracks,
    total: tracks.length,
    nextIndex: 0,
    sent: 0,
    sentTrackKeys: [],
    failed: [],
    status: "pending",
    lockedUntil: null,
    runAfter: null,
    retryCountByTrack: {},
    createdAt: now,
    updatedAt: now,
  };
}

function getArtistJobTrackKey(track) {
  return `${track.mediaType || "song"}:${String(track.permlink || track.title || "").toLowerCase()}`;
}

async function getArtistJob(env, jobId) {
  const kv = getJobStore(env);
  if (!kv || !jobId) {
    return null;
  }
  try {
    const raw = await kv.get(`${JOB_PREFIX}:${jobId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn(`Failed to load job ${jobId}: ${err.message}`);
    return null;
  }
}

async function saveArtistJob(env, job, { ttlSeconds } = {}) {
  const kv = getJobStore(env);
  if (!kv) {
    return;
  }
  job.updatedAt = new Date().toISOString();
  const key = `${JOB_PREFIX}:${job.id}`;
  if (ttlSeconds) {
    await putKv(kv, key, JSON.stringify(job), { expirationTtl: ttlSeconds });
    return;
  }
  await putKv(kv, key, JSON.stringify(job));
}

async function deleteArtistJob(env, jobId) {
  const kv = getJobStore(env);
  if (!kv || !jobId) {
    return;
  }
  try {
    await kv.delete(`${JOB_PREFIX}:${jobId}`);
  } catch (err) {
    console.warn(`Failed to delete job ${jobId}: ${err.message}`);
  }
}

async function clearChatActiveIfMatches(env, chatId, jobId) {
  const kv = getJobStore(env);
  const current = await kv.get(chatActiveKey(chatId));
  if (current === jobId) {
    await kv.delete(chatActiveKey(chatId));
  }
}

async function chatHasActiveJob(env, chatId) {
  const kv = getJobStore(env);
  const activeId = await kv.get(chatActiveKey(chatId));
  if (!activeId) {
    return false;
  }
  const job = await getArtistJob(env, activeId);
  if (job && isActiveStatus(job.status)) {
    return true;
  }
  await kv.delete(chatActiveKey(chatId));
  return false;
}

async function activateArtistJob(env, job, origin) {
  const kv = getJobStore(env);
  job.status = "pending";
  job.runAfter = null;
  job.lockedUntil = null;
  await saveArtistJob(env, job);
  await putKv(kv, chatActiveKey(job.chatId), job.id);
  await addToIndex(kv, ACTIVE_INDEX_KEY, job.id);
  await triggerArtistJobRun(env, origin, job.id);
}

async function queueArtistJob(env, job) {
  const kv = getJobStore(env);
  job.status = "queued";
  await saveArtistJob(env, job);
  await addToIndex(kv, QUEUE_INDEX_KEY, job.id);
}

async function replaceChatQueuedJob(env, chatId, job) {
  const kv = getJobStore(env);
  const existingId = await kv.get(chatQueuedKey(chatId));
  if (existingId && existingId !== job.id) {
    await removeFromIndex(kv, QUEUE_INDEX_KEY, existingId);
    await deleteArtistJob(env, existingId);
  }
  await queueArtistJob(env, job);
  await putKv(kv, chatQueuedKey(chatId), job.id);
}

async function enqueueArtistDelivery(env, chatId, artistName, tracks, origin) {
  const kv = getJobStore(env);
  const token = getBotToken(env);

  if (origin) {
    try {
      await putKv(kv, WORKER_ORIGIN_KEY, origin);
    } catch (err) {
      console.warn(`Failed to persist worker origin: ${err.message}`);
    }
  }

  const job = createJobRecord(chatId, artistName, tracks);

  if (await chatHasActiveJob(env, chatId)) {
    await replaceChatQueuedJob(env, chatId, job);
    await sendMessage(
      chatId,
      `الان یک ارسال در حال انجام است. ${artistName} (${tracks.length} آهنگ) در صف قرار گرفت و بعد از اتمام مورد فعلی شروع می‌شود.`,
      token
    );
    return;
  }

  const existingQueuedId = await kv.get(chatQueuedKey(chatId));
  if (existingQueuedId) {
    await replaceChatQueuedJob(env, chatId, job);
    await sendMessage(
      chatId,
      `درخواست صف‌شده به ${artistName} (${tracks.length} آهنگ) به‌روز شد.`,
      token
    );
    await promoteQueuedJobs(env, origin);
    return;
  }

  const activeCount = (await readJsonArray(kv, ACTIVE_INDEX_KEY)).length;
  if (activeCount < getMaxActiveArtistJobs(env)) {
    await sendMessage(
      chatId,
      `${tracks.length} آهنگ برای ${artistName} پیدا شد. در حال ارسال...`,
      token
    );
    await activateArtistJob(env, job, origin);
    return;
  }

  await queueArtistJob(env, job);
  await putKv(kv, chatQueuedKey(chatId), job.id);
  await sendMessage(
    chatId,
    `ربات الان مشغول است. درخواست ${artistName} (${tracks.length} آهنگ) صف شد و به‌صورت خودکار شروع می‌شود.`,
    token
  );
}

async function enqueueArtistQueueDelivery(env, chatId, artistName, tracks, options = {}) {
  const token = getBotToken(env);
  const payload = createQueuedArtistPayload(chatId, artistName, tracks, options);
  const kv = getJobStore(env);
  const label = payload.warmCache ? "گرم‌کردن کش" : "ارسال";

  if (kv) {
    const activeRaw = await kv.get(queueChatActiveKey(chatId));
    if (activeRaw) {
      let activeArtist = null;
      try {
        activeArtist = JSON.parse(activeRaw)?.artistName || null;
      } catch (_) {
        // ignore
      }

      if (activeArtist && String(activeArtist).toLowerCase() === String(artistName).toLowerCase()) {
        await sendMessage(
          chatId,
          `ارسال ${artistName} همین حالا در حال انجام است و ادامه پیدا می‌کند. برای توقف /cancel را بفرستید.`,
          token
        );
        return payload;
      }

      await putKv(kv, queueChatPendingKey(chatId), JSON.stringify(payload));
      await sendMessage(
        chatId,
        `الان یک ارسال در حال انجام است` +
          (activeArtist ? ` (${activeArtist})` : "") +
          `. ${label} ${artistName} (${tracks.length} آهنگ) بعدی در صف است. برای توقف مورد فعلی /cancel را بفرستید.`,
        token
      );
      return payload;
    }

    try {
      await putKv(
        kv,
        queueChatActiveKey(chatId),
        JSON.stringify({
          artistName,
          total: tracks.length,
          warmCache: Boolean(payload.warmCache),
          startedAt: new Date().toISOString(),
        }),
        { expirationTtl: QUEUE_CHAT_ACTIVE_TTL_S }
      );
    } catch (err) {
      if (!(err instanceof KvWriteLimitError)) {
        throw err;
      }
      console.warn(`Skipping queue chat lock write: ${err.message}`);
    }
  }

  await enqueueArtistQueueMessage(env, payload);
  if (payload.warmCache) {
    await sendMessage(
      chatId,
      `در حال گرم‌کردن کش برای ${artistName}: ${tracks.length} آهنگ بدون کش` +
        (payload.originalTotal ? ` از ${payload.originalTotal}` : "") +
        `. آهنگ‌های قبلاً کش‌شده رد می‌شوند.`,
      token
    );
  } else {
    await sendMessage(chatId, `${tracks.length} آهنگ برای ${artistName} پیدا شد. در حال ارسال...`, token);
  }
  return payload;
}

async function warmArtistMissingTracks(env, chatId, artistName) {
  const token = getBotToken(env);
  try {
    const tracks = await fetchArtistTracks(env, artistName);
    if (!tracks.length) {
      await sendMessage(chatId, `آهنگی برای ${artistName} پیدا نشد.`, token);
      return { artistName, total: 0, missing: 0, queued: 0 };
    }

    const missing = await filterUncachedTracks(env, tracks);
    if (!missing.length) {
      await sendMessage(
        chatId,
        `همهٔ ${tracks.length} آهنگ ${artistName} از قبل در کش هستند. چیزی برای گرم‌کردن نیست.`,
        token
      );
      return { artistName, total: tracks.length, missing: 0, queued: 0 };
    }

    await enqueueArtistQueueDelivery(env, chatId, artistName, missing, {
      warmCache: true,
      originalTotal: tracks.length,
    });
    console.log(
      `Warm artist ${artistName}: queueing ${missing.length}/${tracks.length} uncached tracks for chat ${chatId}`
    );
    return {
      artistName,
      total: tracks.length,
      missing: missing.length,
      queued: missing.length,
    };
  } catch (err) {
    console.error(`Warm artist ${artistName} failed: ${err.message}`);
    await sendMessage(chatId, `گرم‌کردن کش برای ${artistName} ناموفق بود: ${err.message}`, token);
    throw err;
  }
}

async function promotePendingQueueChatDelivery(env, chatId) {
  const kv = getJobStore(env);
  if (!kv) {
    return;
  }

  const pendingKey = queueChatPendingKey(chatId);
  const pendingRaw = await kv.get(pendingKey);
  if (!pendingRaw) {
    return;
  }

  try {
    await kv.delete(pendingKey);
  } catch (err) {
    console.warn(`Failed to clear pending queue delivery for ${chatId}: ${err.message}`);
  }

  let pending;
  try {
    pending = JSON.parse(pendingRaw);
  } catch (err) {
    console.warn(`Invalid pending queue payload for ${chatId}: ${err.message}`);
    return;
  }

  if (!pending?.artistName || !Array.isArray(pending.tracks)) {
    return;
  }

  try {
    await putKv(
      kv,
      queueChatActiveKey(chatId),
      JSON.stringify({
        artistName: pending.artistName,
        total: pending.total || pending.tracks.length,
        startedAt: new Date().toISOString(),
      }),
      { expirationTtl: QUEUE_CHAT_ACTIVE_TTL_S }
    );
  } catch (err) {
    if (!(err instanceof KvWriteLimitError)) {
      throw err;
    }
    console.warn(`Skipping queue chat lock write while promoting: ${err.message}`);
  }

  await enqueueArtistQueueMessage(env, pending);
  await sendMessage(
    chatId,
    `شروع ارسال صف‌شده برای ${pending.artistName} (${pending.total || pending.tracks.length} آهنگ)...`,
    getBotToken(env)
  );
}

async function finishQueueChatDelivery(env, payload) {
  const kv = getJobStore(env);
  if (!kv || !payload?.chatId) {
    return;
  }

  const activeKey = queueChatActiveKey(payload.chatId);
  try {
    const activeRaw = await kv.get(activeKey);
    if (activeRaw) {
      let shouldClear = true;
      try {
        const active = JSON.parse(activeRaw);
        if (active?.artistName && payload.artistName && active.artistName !== payload.artistName) {
          shouldClear = false;
        }
      } catch (_) {
        // Clear unreadable lock records.
      }
      if (shouldClear) {
        await kv.delete(activeKey);
      }
    }
  } catch (err) {
    console.warn(`Failed to clear queue chat lock for ${payload.chatId}: ${err.message}`);
  }

  await promotePendingQueueChatDelivery(env, payload.chatId);
}

async function handleArtistDeliveryDlq(env, body) {
  const payload = normalizeQueuePayload(body);
  const token = getBotToken(env);
  const nextSong = Math.min((payload.nextIndex || 0) + 1, payload.total || 0);
  const progress = `در آهنگ ${nextSong}/${payload.total || 0} متوقف شد (ارسال‌شده: ${payload.sent || 0}).`;
  const retryCount = Number(payload.dlqRetryCount || 0);
  console.error(
    `Artist delivery DLQ for ${payload.artistName} chat ${payload.chatId}: ${progress} retry=${retryCount}`
  );

  // Auto-retry once from DLQ, then give up and notify.
  if (retryCount < 1 && payload.chatId && Array.isArray(payload.tracks) && payload.nextIndex < payload.total) {
    payload.dlqRetryCount = retryCount + 1;
    payload.rateLimitBoost = Math.min((payload.rateLimitBoost || 0) + 5, 30);
    try {
      const delaySeconds = Math.max(getArtistQueueDelaySeconds(env) + (payload.rateLimitBoost || 0), 5);
      await enqueueArtistQueueMessage(env, payload, { delaySeconds });
      await sendMessage(
        payload.chatId,
        `ارسال ${payload.artistName} به صف خطا رفت. یک‌بار دیگر از آهنگ ${nextSong}/${payload.total} تلاش می‌شود...`,
        token
      );
      console.log(`DLQ auto-retry queued for ${payload.artistName} chat ${payload.chatId}`);
      return;
    } catch (err) {
      console.warn(`DLQ auto-retry enqueue failed: ${err.message}`);
    }
  }

  try {
    await sendMessage(
      payload.chatId,
      `ارسال ${payload.artistName} بعد از چند خطای پیاپی متوقف شد. ${progress} دوباره لینک خواننده را بفرستید یا /search ${payload.artistName}.`,
      token
    );
  } catch (err) {
    console.warn(`Failed to notify chat about artist DLQ: ${err.message}`);
  }

  await finishQueueChatDelivery(env, payload);
}

async function triggerArtistJobRun(env, origin, jobId) {
  if (!origin && !env.WORKER_SELF) {
    console.warn(`No worker origin available to trigger job ${jobId}; watchdog will resume it.`);
    return false;
  }

  const secret = env.JOB_RUNNER_SECRET;
  if (!secret) {
    console.warn(`JOB_RUNNER_SECRET missing; watchdog will resume job ${jobId}.`);
    return false;
  }

  const triggerUrl = `${origin || "https://worker-self"}/internal/run-artist-job?id=${encodeURIComponent(jobId)}`;
  const request = new Request(triggerUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });

  try {
    const response = env.WORKER_SELF ? await env.WORKER_SELF.fetch(request) : await fetch(request);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(
        `Failed to trigger job run ${jobId}: HTTP ${response.status} ${body.slice(0, 120)}`
      );
      return false;
    }

    console.log(`Triggered next artist batch for job ${jobId}`);
    return true;
  } catch (err) {
    console.warn(`Failed to trigger job run ${jobId}: ${err.message}`);
    return false;
  }
}

async function triggerStatelessArtistRun(env, origin, payload) {
  if (!env.WORKER_SELF && !origin) {
    console.warn(`No worker origin available for stateless artist run ${payload.artistName}`);
    return false;
  }

  const secret = env.JOB_RUNNER_SECRET;
  if (!secret) {
    console.warn(`JOB_RUNNER_SECRET missing; cannot continue stateless artist run ${payload.artistName}.`);
    return false;
  }

  const triggerUrl = `${origin || "https://worker-self"}/internal/run-artist-stateless`;
  const request = new Request(triggerUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  try {
    const response = env.WORKER_SELF ? await env.WORKER_SELF.fetch(request) : await fetch(request);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(
        `Failed to trigger stateless artist run ${payload.artistName}: HTTP ${response.status} ${body.slice(0, 120)}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`Failed to trigger stateless artist run ${payload.artistName}: ${err.message}`);
    return false;
  }
}

function createStatelessArtistPayload(chatId, artistName, tracks) {
  return {
    chatId,
    artistName,
    tracks,
    total: tracks.length,
    nextIndex: 0,
    sent: 0,
    failed: [],
    sentTrackKeys: [],
  };
}

function compactQueuedTrack(track) {
  return {
    permlink: track.permlink,
    title: track.title || track.permlink,
    mediaType: track.mediaType || "song",
  };
}

function createQueuedArtistPayload(chatId, artistName, tracks, options = {}) {
  const payload = {
    chatId,
    artistName,
    tracks: tracks.map(compactQueuedTrack),
    total: tracks.length,
    nextIndex: 0,
    sent: 0,
    failed: [],
    sentTrackKeys: [],
    createdAt: new Date().toISOString(),
  };
  if (options.warmCache) {
    payload.warmCache = true;
  }
  if (Number.isFinite(options.originalTotal) && options.originalTotal > 0) {
    payload.originalTotal = options.originalTotal;
  }
  return payload;
}

function normalizeQueuePayload(body) {
  if (typeof body === "string") {
    return JSON.parse(body);
  }
  return body;
}

async function enqueueArtistQueueMessage(env, payload, options = {}) {
  if (!env.ARTIST_QUEUE) {
    throw new Error("ARTIST_QUEUE binding is not configured");
  }
  await env.ARTIST_QUEUE.send(payload, options);
}

async function runQueuedArtistMessage(env, body) {
  const payload = normalizeQueuePayload(body);
  const token = getBotToken(env);
  payload.sentTrackKeys ||= [];
  payload.failed ||= [];

  if (await isChatDeliveryCancelled(env, payload.chatId, payload.createdAt)) {
    // Timestamp latch: only payloads created at/before cancel time are stopped.
    console.log(`Queue artist delivery ${payload.artistName}: cancelled by user`);
    try {
      const kv = getJobStore(env);
      if (kv) {
        await kv.delete(queueChatActiveKey(payload.chatId));
      }
    } catch (_) {
      // best effort
    }
    return;
  }

  console.log(
    `Queue artist delivery ${payload.artistName}: starting index ${payload.nextIndex + 1}/${payload.total}`
  );

  while (payload.nextIndex < payload.total) {
    const track = payload.tracks[payload.nextIndex];
    const trackKey = getArtistJobTrackKey(track);

    if (payload.sentTrackKeys.includes(trackKey)) {
      payload.nextIndex += 1;
      continue;
    }

    try {
      await sendTrackToUser(payload.chatId, track, env, {
        preferUrl: true,
        // Warm jobs always write cache; normal artist delivery keeps free-tier bulk writes off.
        cacheUploads: Boolean(payload.warmCache) || shouldCacheArtistUploads(env),
      });
      payload.sentTrackKeys.push(trackKey);
      payload.sent += 1;
      payload.nextIndex += 1;
      console.log(
        `Queue artist delivery ${payload.artistName}: sent ${payload.sent}/${payload.total}`
      );

      const every = getArtistProgressEvery(env);
      if (every > 0 && payload.sent % every === 0 && payload.nextIndex < payload.total) {
        await sendMessage(
          payload.chatId,
          `پیشرفت: ${payload.sent}/${payload.total} آهنگ از ${payload.artistName} ارسال شد...`,
          token
        );
      }
    } catch (err) {
      if (err instanceof TelegramRateLimitError) {
        throw err;
      }

      payload.failed.push(track.title || track.permlink);
      payload.nextIndex += 1;
      console.warn(`Queue artist delivery failed for ${track.permlink}: ${err.message}`);
    }

    break;
  }

  if (payload.nextIndex >= payload.total) {
    let summary = payload.warmCache
      ? `گرم‌کردن کش ${payload.artistName} تمام شد. ${payload.sent}/${payload.total} آهنگِ قبلیِ بدون کش ارسال/کش شد` +
        (payload.originalTotal ? ` (از ${payload.originalTotal} آهنگ کل)` : "") +
        `.`
      : `ارسال ${payload.artistName} تمام شد. ${payload.sent}/${payload.total} آهنگ ارسال شد.`;
    if (payload.failed.length) {
      summary += `\n\nارسال نشد:\n${payload.failed.join("\n")}`;
    }
    await sendMessage(payload.chatId, summary, token);
    console.log(`Queue artist delivery ${payload.artistName}: completed`);
    await finishQueueChatDelivery(env, payload);
    return;
  }

  const delaySeconds = Math.max(
    getArtistQueueDelaySeconds(env) + Number(payload.rateLimitBoost || 0),
    getArtistQueueDelaySeconds(env)
  );
  await enqueueArtistQueueMessage(env, payload, { delaySeconds });
  console.log(
    `Queue artist delivery ${payload.artistName}: enqueued index ${
      payload.nextIndex + 1
    }/${payload.total} after ${delaySeconds}s`
  );
}

async function runStatelessArtistBatch(env, payload, origin) {
  const token = getBotToken(env);
  payload.sentTrackKeys ||= [];
  payload.failed ||= [];

  while (payload.nextIndex < payload.total) {
    const track = payload.tracks[payload.nextIndex];
    const trackKey = getArtistJobTrackKey(track);

    if (payload.sentTrackKeys.includes(trackKey)) {
      payload.nextIndex += 1;
      continue;
    }

    try {
      await sendTrackToUser(payload.chatId, track, env, { preferUrl: true, cacheUploads: false });
      payload.sentTrackKeys.push(trackKey);
      payload.sent += 1;
      payload.nextIndex += 1;
    } catch (err) {
      if (err instanceof TelegramRateLimitError) {
        await sendMessage(
          payload.chatId,
          `تلگرام ارسال را محدود کرده است. برای ادامهٔ ${payload.artistName} بعداً دوباره تلاش کنید.`,
          token
        );
        return;
      }

      payload.failed.push(track.title || track.permlink);
      payload.nextIndex += 1;
      console.warn(`Stateless artist run failed for ${track.permlink}: ${err.message}`);
    }

    break;
  }

  if (payload.nextIndex >= payload.total) {
    let summary = `ارسال ${payload.artistName} تمام شد. ${payload.sent}/${payload.total} آهنگ ارسال شد.`;
    if (payload.failed.length) {
      summary += `\n\nارسال نشد:\n${payload.failed.join("\n")}`;
    }
    await sendMessage(payload.chatId, summary, token);
    return;
  }

  const triggered = await triggerStatelessArtistRun(env, origin, payload);
  if (!triggered) {
    await sendMessage(
      payload.chatId,
      `ارسال در ${payload.sent}/${payload.total} آهنگ متوقف شد چون ادامهٔ موقت بدون KV شروع نشد.`,
      token
    );
  }
}

async function runArtistJobBatch(env, jobId, origin, ctx) {
  try {
    await runArtistJobBatchImpl(env, jobId, origin, ctx);
  } catch (err) {
    if (!(err instanceof KvWriteLimitError)) {
      throw err;
    }

    console.warn(`Artist job ${jobId} paused because KV writes are unavailable: ${err.message}`);
    const job = await getArtistJob(env, jobId);
    if (job?.chatId) {
      try {
        await sendMessage(
          job.chatId,
          "سهمیهٔ نوشتن KV کلادفلر پر شده است؛ ارسال خواننده تا ریست سهمیهٔ روزانه متوقف می‌ماند.",
          getBotToken(env)
        );
      } catch (sendErr) {
        console.warn(`Failed to notify chat about KV quota: ${sendErr.message}`);
      }
    }
  }
}

async function runArtistJobBatchImpl(env, jobId, origin, ctx) {
  const kv = getJobStore(env);
  if (!kv) {
    return;
  }

  const job = await getArtistJob(env, jobId);
  if (!job) {
    console.warn(`Job ${jobId} not found`);
    await removeFromIndex(kv, ACTIVE_INDEX_KEY, jobId);
    return;
  }

  if (job.status === "completed" || job.status === "cancelled") {
    await clearChatActiveIfMatches(env, job.chatId, job.id);
    await removeFromIndex(kv, ACTIVE_INDEX_KEY, job.id);
    await promoteQueuedJobs(env, origin);
    return;
  }

  const now = Date.now();

  if (job.runAfter && Date.parse(job.runAfter) > now) {
    console.log(`Job ${jobId} is waiting until ${job.runAfter}`);
    return;
  }

  if (job.lockedUntil && Date.parse(job.lockedUntil) > now) {
    console.log(`Job ${jobId} is locked until ${job.lockedUntil}; another run is active`);
    return;
  }

  job.status = "running";
  job.lockedUntil = new Date(now + JOB_LOCK_LEASE_MS).toISOString();
  job.runAfter = null;
  await saveArtistJob(env, job);

  const runStart = Date.now();
  let processed = 0;
  let rateLimited = false;
  job.sentTrackKeys ||= [];

  while (job.nextIndex < job.total && processed < ARTIST_BATCH_SIZE) {
    if (Date.now() - runStart > JOB_RUN_TIME_BUDGET_MS) {
      console.log(`Job ${jobId} reached its time budget; continuing in next run`);
      break;
    }

    const index = job.nextIndex;
    const track = job.tracks[index];
    const trackKey = getArtistJobTrackKey(track);

    if (job.sentTrackKeys.includes(trackKey)) {
      console.warn(`Job ${jobId} skipping duplicate track ${index} (${track.permlink})`);
      job.nextIndex += 1;
      await saveArtistJob(env, job);
      continue;
    }

    try {
      await sendTrackToUser(job.chatId, track, env, { preferUrl: true, cacheUploads: false });
      if (!job.sentTrackKeys.includes(trackKey)) {
        job.sentTrackKeys.push(trackKey);
        job.sent += 1;
      }
      job.nextIndex += 1;
      processed += 1;
      delete job.retryCountByTrack[index];
      job.status = "pending";
      job.lockedUntil = null;
      await saveArtistJob(env, job);
    } catch (err) {
      if (err instanceof TelegramRateLimitError) {
        const retryAfter = err.retryAfter || RATE_LIMIT_FALLBACK_SECONDS;
        job.runAfter = new Date(Date.now() + retryAfter * 1000).toISOString();
        job.lockedUntil = null;
        await saveArtistJob(env, job);
        console.warn(`Job ${jobId} rate limited; pausing for ${retryAfter}s`);
        rateLimited = true;
        break;
      }

      const attempts = (job.retryCountByTrack[index] || 0) + 1;
      job.retryCountByTrack[index] = attempts;
      if (attempts >= MAX_TRACK_ATTEMPTS) {
        job.failed.push(track.title || track.permlink);
        job.nextIndex += 1;
        processed += 1;
        delete job.retryCountByTrack[index];
        job.status = "pending";
        job.lockedUntil = null;
        await saveArtistJob(env, job);
        console.warn(`Job ${jobId} gave up on track ${index} (${track.permlink}): ${err.message}`);
      } else {
        job.status = "pending";
        job.lockedUntil = null;
        await saveArtistJob(env, job);
        console.warn(`Job ${jobId} track ${index} attempt ${attempts} failed: ${err.message}; retrying soon`);
        // Leave nextIndex in place so a fresh run retries this track.
        break;
      }
    }
  }

  if (rateLimited) {
    return;
  }

  if (job.nextIndex >= job.total) {
    await completeArtistJob(env, job, origin);
    return;
  }

  job.status = "pending";
  job.lockedUntil = null;
  if (processed === 0) {
    await saveArtistJob(env, job);
  }
  const triggered = await triggerArtistJobRun(env, origin, jobId);
  if (!triggered) {
    console.warn(`Job ${jobId} is pending; watchdog will retry continuation.`);
  }
}

async function completeArtistJob(env, job, origin) {
  const kv = getJobStore(env);
  const token = getBotToken(env);

  job.status = "completed";
  job.lockedUntil = null;
  job.runAfter = null;
  await saveArtistJob(env, job, { ttlSeconds: COMPLETED_JOB_TTL_S });

  await clearChatActiveIfMatches(env, job.chatId, job.id);
  await removeFromIndex(kv, ACTIVE_INDEX_KEY, job.id);

  let summary = `ارسال ${job.artistName} تمام شد. ${job.sent}/${job.total} آهنگ ارسال شد.`;
  if (job.failed.length) {
    summary += `\n\nارسال نشد:\n${job.failed.join("\n")}`;
  }
  try {
    await sendMessage(job.chatId, summary, token);
  } catch (err) {
    console.warn(`Failed to send completion summary for job ${job.id}: ${err.message}`);
  }

  await promoteQueuedJobs(env, origin);
}

async function promoteQueuedJobs(env, origin) {
  const kv = getJobStore(env);
  if (!kv) {
    return;
  }

  const queue = await readJsonArray(kv, QUEUE_INDEX_KEY);
  if (!queue.length) {
    return;
  }

  const activeIds = await readJsonArray(kv, ACTIVE_INDEX_KEY);
  const remaining = [];
  let changed = false;

  for (const jobId of queue) {
    if (activeIds.length >= getMaxActiveArtistJobs(env)) {
      remaining.push(jobId);
      continue;
    }

    const job = await getArtistJob(env, jobId);
    if (!job || job.status === "cancelled" || job.status === "completed") {
      changed = true;
      continue;
    }

    if (await chatHasActiveJob(env, job.chatId)) {
      remaining.push(jobId);
      continue;
    }

    job.status = "pending";
    job.runAfter = null;
    job.lockedUntil = null;
    await saveArtistJob(env, job);
    await kv.delete(chatQueuedKey(job.chatId));
    await putKv(kv, chatActiveKey(job.chatId), job.id);
    activeIds.push(job.id);
    changed = true;
    console.log(`Promoted queued job ${job.id} for chat ${job.chatId}`);
    await triggerArtistJobRun(env, origin, job.id);
  }

  if (changed) {
    await writeJsonArray(kv, QUEUE_INDEX_KEY, remaining);
    await writeJsonArray(kv, ACTIVE_INDEX_KEY, activeIds);
  }
}

async function runWatchdog(env, ctx) {
  if (!artistJobsEnabled(env)) {
    return;
  }

  const kv = getJobStore(env);
  const origin = await kv.get(WORKER_ORIGIN_KEY);
  const now = Date.now();

  const activeIds = await readJsonArray(kv, ACTIVE_INDEX_KEY);
  let triggered = 0;

  for (const jobId of activeIds) {
    if (triggered >= WATCHDOG_MAX_JOBS) {
      break;
    }

    const job = await getArtistJob(env, jobId);
    if (!job) {
      await removeFromIndex(kv, ACTIVE_INDEX_KEY, jobId);
      continue;
    }

    if (job.status === "completed" || job.status === "cancelled") {
      await clearChatActiveIfMatches(env, job.chatId, jobId);
      await removeFromIndex(kv, ACTIVE_INDEX_KEY, jobId);
      continue;
    }

    const lockExpired = !job.lockedUntil || Date.parse(job.lockedUntil) <= now;
    const backoffPassed = !job.runAfter || Date.parse(job.runAfter) <= now;
    if (lockExpired && backoffPassed) {
      triggered += 1;
      console.log(`Watchdog resuming job ${jobId}`);
      if (ctx) {
        ctx.waitUntil(runArtistJobBatch(env, jobId, origin, ctx));
        continue;
      }
      await triggerArtistJobRun(env, origin, jobId);
    }
  }

  await promoteQueuedJobs(env, origin);
}

async function isChatDeliveryCancelled(env, chatId, payloadCreatedAt = null) {
  const kv = getJobStore(env);
  if (!kv || !chatId) {
    return false;
  }
  try {
    const raw = await kv.get(queueChatCancelKey(chatId));
    if (!raw) {
      return false;
    }
    let cancelledAtMs = NaN;
    try {
      const parsed = JSON.parse(raw);
      cancelledAtMs = Date.parse(parsed?.cancelledAt || "");
    } catch {
      // Legacy cancel flags were plain "1".
      cancelledAtMs = Date.now();
    }
    if (!Number.isFinite(cancelledAtMs)) {
      return true;
    }
    if (!payloadCreatedAt) {
      return true;
    }
    const createdAtMs = Date.parse(payloadCreatedAt);
    if (!Number.isFinite(createdAtMs)) {
      return true;
    }
    return createdAtMs <= cancelledAtMs;
  } catch {
    return false;
  }
}

async function cancelChatArtistDelivery(env, chatId) {
  const kv = getJobStore(env);
  const token = getBotToken(env);
  if (!kv) {
    await sendMessage(chatId, "بدون ARTIST_JOB_STORE امکان لغو وجود ندارد.", token);
    return { cancelled: false };
  }

  let activeArtist = null;
  try {
    const activeRaw = await kv.get(queueChatActiveKey(chatId));
    if (activeRaw) {
      activeArtist = JSON.parse(activeRaw)?.artistName || null;
    }
  } catch (_) {
    // ignore
  }

  try {
    await putKv(
      kv,
      queueChatCancelKey(chatId),
      JSON.stringify({ cancelledAt: new Date().toISOString() }),
      { expirationTtl: 60 * 60 }
    );
    await kv.delete(queueChatActiveKey(chatId));
    await kv.delete(queueChatPendingKey(chatId));
  } catch (err) {
    console.warn(`Cancel cleanup failed for ${chatId}: ${err.message}`);
  }

  await sendMessage(
    chatId,
    activeArtist
      ? `لغو ${activeArtist} ثبت شد. ارسال به‌زودی متوقف می‌شود.`
      : "ارسال فعالِ خواننده‌ای برای این چت پیدا نشد. اگر هنوز آهنگ می‌آید، کمی صبر کنید و دوباره /cancel بفرستید.",
    token
  );
  return { cancelled: true, activeArtist };
}

async function readUserRecents(env, chatId) {
  const kv = getJobStore(env);
  if (!kv) {
    return [];
  }
  try {
    const raw = await kv.get(userRecentKey(chatId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function pushUserRecent(env, chatId, item) {
  const kv = getJobStore(env);
  if (!kv || !chatId || !item) {
    return;
  }
  try {
    const existing = await readUserRecents(env, chatId);
    const key = `${item.type}:${String(item.value || "").toLowerCase()}`;
    const next = [
      { ...item, at: new Date().toISOString() },
      ...existing.filter((entry) => `${entry.type}:${String(entry.value || "").toLowerCase()}` !== key),
    ].slice(0, MAX_RECENT_ITEMS);
    await putKv(kv, userRecentKey(chatId), JSON.stringify(next), { expirationTtl: 30 * 24 * 60 * 60 });
  } catch (err) {
    if (!(err instanceof KvWriteLimitError)) {
      console.warn(`Failed to store recent item for ${chatId}: ${err.message}`);
    }
  }
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

function summarizeSearchResults(artists, songs) {
  const lines = ["نتایج جستجو — روی دکمه بزنید:"];
  if (artists.length) {
    lines.push("", "خواننده‌ها:");
    for (const artist of artists) {
      lines.push(`• ${artist.name}`);
    }
  }
  if (songs.length) {
    lines.push("", "آهنگ‌ها:");
    for (const song of songs) {
      lines.push(`• ${song.artist ? `${song.artist} - ` : ""}${song.song || song.title || song.permlink}`);
    }
  }
  if (!artists.length && !songs.length) {
    return "آهنگ یا خواننده‌ای پیدا نشد.";
  }
  return lines.join("\n");
}

async function buildSearchKeyboard(env, artists, songs) {
  const rows = [];
  for (const artist of artists) {
    rows.push([
      {
        text: `🎤 ${artist.name}`.slice(0, 64),
        callback_data: await makeCallbackData(env, "a", artist.query || artist.name),
      },
    ]);
  }
  for (const song of songs) {
    const label = `${song.artist ? `${song.artist} - ` : ""}${song.song || song.title || song.permlink}`;
    rows.push([
      {
        text: `🎵 ${label}`.slice(0, 64),
        callback_data: await makeCallbackData(env, "s", song.permlink),
      },
    ]);
  }
  return { inline_keyboard: rows };
}

async function searchRadioJavan(env, query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    return { artists: [], songs: [] };
  }

  const data = await fetchRadioJavanApi(
    env,
    `/api/p/search?query=${encodeURIComponent(trimmed)}`,
    `/search`
  );

  const artists = [];
  const songs = [];
  const seenArtists = new Set();
  const seenSongs = new Set();

  const pushArtist = (item) => {
    const name = item?.name || item?.query || item?.id;
    const queryName = item?.query || item?.name || item?.id;
    if (!name || !queryName) {
      return;
    }
    const key = String(queryName).toLowerCase();
    if (seenArtists.has(key)) {
      return;
    }
    seenArtists.add(key);
    artists.push({ name: String(name), query: String(queryName) });
  };

  const pushSong = (item) => {
    if (!item?.permlink || isSkippedTrack(item)) {
      return;
    }
    const key = String(item.permlink).toLowerCase();
    if (seenSongs.has(key)) {
      return;
    }
    seenSongs.add(key);
    songs.push({
      permlink: item.permlink,
      title: item.title || item.song || item.permlink,
      song: item.song || item.title || item.permlink,
      artist: item.artist || "",
    });
  };

  for (const item of data.top || []) {
    if (item?.type === "artist") {
      pushArtist(item);
    } else if (item?.permlink || item?.type === "mp3") {
      pushSong(item);
    }
  }
  for (const item of data.artists || []) {
    pushArtist(item);
  }
  for (const item of data.all_artists || []) {
    pushArtist(item);
  }
  for (const item of data.mp3s || []) {
    pushSong(item);
  }

  return {
    artists: artists.slice(0, MAX_SEARCH_ARTISTS),
    songs: songs.slice(0, MAX_SEARCH_SONGS),
  };
}

async function handleSearchQuery(chatId, query, env) {
  const token = getBotToken(env);
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    await sendMessage(chatId, "نحوهٔ استفاده: /search <آهنگ یا خواننده>", token);
    return;
  }

  await sendMessage(chatId, `در حال جستجو برای «${trimmed}»...`, token);
  const { artists, songs } = await searchRadioJavan(env, trimmed);
  await pushUserRecent(env, chatId, { type: "search", value: trimmed, label: trimmed });

  if (!artists.length && !songs.length) {
    await sendMessage(chatId, `نتیجه‌ای برای «${trimmed}» پیدا نشد.`, token);
    return;
  }

  const keyboard = await buildSearchKeyboard(env, artists, songs);
  await sendMessage(chatId, summarizeSearchResults(artists, songs), token, {
    reply_markup: keyboard,
  });
}

async function handleRecentCommand(chatId, env) {
  const token = getBotToken(env);
  const recents = await readUserRecents(env, chatId);
  if (!recents.length) {
    await sendMessage(chatId, "هنوز جستجو یا دانلودی ثبت نشده است.", token);
    return;
  }

  const rows = [];
  const lines = ["فعالیت‌های اخیر:"];
  for (const item of recents) {
    if (item.type === "search") {
      lines.push(`• جستجو: ${item.label || item.value}`);
      rows.push([
        {
          text: `🔎 ${item.label || item.value}`.slice(0, 64),
          callback_data: await makeCallbackData(env, "q", item.value),
        },
      ]);
    } else if (item.type === "artist") {
      lines.push(`• خواننده: ${item.label || item.value}`);
      rows.push([
        {
          text: `🎤 ${item.label || item.value}`.slice(0, 64),
          callback_data: await makeCallbackData(env, "a", item.value),
        },
      ]);
    } else if (item.type === "song") {
      lines.push(`• آهنگ: ${item.label || item.value}`);
      rows.push([
        {
          text: `🎵 ${item.label || item.value}`.slice(0, 64),
          callback_data: await makeCallbackData(env, "s", item.value),
        },
      ]);
    }
  }

  await sendMessage(chatId, lines.join("\n"), token, {
    reply_markup: { inline_keyboard: rows },
  });
}

async function handleStatusCommand(chatId, userId, env) {
  const token = getBotToken(env);
  if (!isAdminUser(env, userId)) {
    await sendMessage(chatId, "/status فقط برای ادمین است.", token);
    return;
  }

  const kv = getJobStore(env);
  let active = null;
  let pending = null;
  let cancel = false;
  if (kv) {
    try {
      const activeRaw = await kv.get(queueChatActiveKey(chatId));
      const pendingRaw = await kv.get(queueChatPendingKey(chatId));
      cancel = Boolean(await kv.get(queueChatCancelKey(chatId)));
      active = activeRaw ? JSON.parse(activeRaw) : null;
      pending = pendingRaw ? JSON.parse(pendingRaw) : null;
    } catch (err) {
      console.warn(`Status read failed: ${err.message}`);
    }
  }

  const lines = [
    "وضعیت ادمین",
    `صف ربات: ${ARTIST_DELIVERY_QUEUE_NAME}`,
    `صف خطا (dlq): ${ARTIST_DELIVERY_DLQ_NAME}`,
    `نوشتن انبوه کش: ${shouldCacheArtistUploads(env)}`,
    `تأخیر صف: ${getArtistQueueDelaySeconds(env)}ث`,
    `بازهٔ پیشرفت: ${getArtistProgressEvery(env)}`,
    `فعال: ${active ? `${active.artistName} (${active.total || "?"})` : "هیچ"}`,
    `در انتظار: ${pending ? `${pending.artistName} (${pending.total || pending.tracks?.length || "?"})` : "هیچ"}`,
    `پرچم لغو: ${cancel ? "بله" : "خیر"}`,
    `ادمین‌ها: ${getAdminUserIds(env).join(", ") || "(هیچ)"}`,
  ];
  await sendMessage(chatId, lines.join("\n"), token);
}

async function handleCallbackQuery(callbackQuery, env, origin) {
  const token = getBotToken(env);
  const chatId = callbackQuery.message?.chat?.id || callbackQuery.from?.id;
  const data = callbackQuery.data;
  if (!chatId || !data) {
    return;
  }

  try {
    await answerCallbackQuery(callbackQuery.id, token);
  } catch (err) {
    console.warn(`answerCallbackQuery failed: ${err.message}`);
  }

  const resolved = await resolveCallbackData(env, data);
  if (!resolved?.type || !resolved?.value) {
    await sendMessage(chatId, "این دکمه منقضی شده. لطفاً دوباره جستجو کنید.", token);
    return;
  }

  if (resolved.type === "q") {
    await handleSearchQuery(chatId, resolved.value, env);
    return;
  }

  if (resolved.type === "a") {
    const artistName = resolved.value;
    await pushUserRecent(env, chatId, {
      type: "artist",
      value: artistName,
      label: artistName,
    });
    await handleUrl(chatId, `https://play.radiojavan.com/artist/${encodeURIComponent(artistName)}`, env, origin);
    return;
  }

  if (resolved.type === "s") {
    const permlink = resolved.value;
    await pushUserRecent(env, chatId, {
      type: "song",
      value: permlink,
      label: permlink,
    });
    await handleUrl(chatId, `https://play.radiojavan.com/song/${encodeURIComponent(permlink)}`, env, origin);
    return;
  }

  await sendMessage(chatId, "عملکرد این دکمه شناخته نشد.", token);
}

async function handleInlineQuery(inlineQuery, env) {
  const token = getBotToken(env);
  const query = inlineQuery.query?.trim() || "";
  const userId = inlineQuery.from?.id;
  let artists = [];
  let songs = [];

  try {
    if (query) {
      ({ artists, songs } = await searchRadioJavan(env, query));
      if (userId) {
        await pushUserRecent(env, userId, { type: "search", value: query, label: query });
      }
    } else if (userId) {
      const recents = await readUserRecents(env, userId);
      for (const item of recents) {
        if (item.type === "artist") {
          artists.push({ name: item.label || item.value, query: item.value });
        } else if (item.type === "song") {
          songs.push({
            permlink: item.value,
            title: item.label || item.value,
            song: item.label || item.value,
            artist: "",
          });
        }
      }
      artists = artists.slice(0, MAX_SEARCH_ARTISTS);
      songs = songs.slice(0, MAX_SEARCH_SONGS);
    }
  } catch (err) {
    console.warn(`Inline search failed: ${err.message}`);
  }

  const results = [];
  for (const artist of artists) {
    const link = `https://play.radiojavan.com/artist/${encodeURIComponent(artist.query || artist.name)}`;
    results.push({
      type: "article",
      id: `a-${String(artist.query || artist.name).slice(0, 40)}`,
      title: `خواننده: ${artist.name}`,
      description: "ارسال لینک خواننده برای دانلود همهٔ آهنگ‌ها",
      input_message_content: { message_text: link },
    });
  }
  for (const song of songs) {
    const link = `https://play.radiojavan.com/song/${encodeURIComponent(song.permlink)}`;
    results.push({
      type: "article",
      id: `s-${String(song.permlink).slice(0, 50)}`,
      title: song.artist ? `${song.artist} - ${song.song || song.title}` : song.song || song.title || song.permlink,
      description: "ارسال لینک آهنگ برای دانلود",
      input_message_content: { message_text: link },
    });
  }

  if (!results.length) {
    results.push({
      type: "article",
      id: "empty",
      title: query ? "نتیجه‌ای نیست" : "برای جستجو در رادیو جوان بنویسید",
      description: query ? `چیزی برای ${query} پیدا نشد` : "نام خواننده یا آهنگ را امتحان کنید",
      input_message_content: {
        message_text: query
          ? `نتیجه‌ای در رادیو جوان برای ${query} پیدا نشد`
          : "برای جستجو بنویسید: @bot <عبارت>",
      },
    });
  }

  try {
    await answerInlineQuery(inlineQuery.id, results.slice(0, 20), token);
  } catch (err) {
    // Synthetic webhook tests and stale inline queries can fail here; ignore quietly.
    console.warn(`answerInlineQuery failed: ${err.message}`);
  }
}

async function processUpdate(update, env, origin) {
  const token = getBotToken(env);

  try {
    if (!token) {
      console.error("BOT_TOKEN not configured");
      return;
    }

    if (update.inline_query) {
      await handleInlineQuery(update.inline_query, env);
      return;
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env, origin);
      return;
    }

    const message = update.message || update.edited_message;
    if (!message) {
      return;
    }

    const chatId = message.chat?.id;
    if (!chatId) {
      return;
    }

    const userId = message.from?.id || chatId;
    const text = message.text?.trim();
    const link = extractLinkFromMessage(message);
    const command = parseBotCommand(text || "");

    if (command?.name === "start") {
      await sendMessage(
        chatId,
        "به ربات دانلود رادیو جوان خوش آمدید.\n\nلینک آهنگ/خواننده بفرستید، از /search استفاده کنید، یا حالت اینلاین را امتحان کنید.\n\n" +
          HELP_TEXT,
        token
      );
      return;
    }

    if (command?.name === "help") {
      await sendMessage(chatId, HELP_TEXT, token);
      return;
    }

    if (command?.name === "cancel") {
      await cancelChatArtistDelivery(env, chatId);
      return;
    }

    if (command?.name === "status") {
      await handleStatusCommand(chatId, userId, env);
      return;
    }

    if (command?.name === "recent" || command?.name === "recents") {
      await handleRecentCommand(chatId, env);
      return;
    }

    if (command?.name === "search") {
      await handleSearchQuery(chatId, command.arg, env);
      return;
    }

    if (link) {
      try {
        const parsed = parseMediaFromUrl(
          link.startsWith("https://rj.app/") ? link : normalizeInput(link)
        );
        if (parsed.mediaType === "artist") {
          await pushUserRecent(env, chatId, {
            type: "artist",
            value: parsed.mediaName,
            label: parsed.mediaName,
          });
        } else if (parsed.mediaType === "song") {
          await pushUserRecent(env, chatId, {
            type: "song",
            value: parsed.mediaName,
            label: parsed.mediaName,
          });
        }
      } catch (_) {
        // Link may be a short URL; handleUrl will resolve it.
      }
      await handleUrl(chatId, link, env, origin);
      return;
    }

    if (text) {
      await handleSearchQuery(chatId, text, env);
    }
  } catch (err) {
    console.error(`processUpdate failed: ${err.message}`);
    const chatId =
      update.message?.chat?.id ||
      update.edited_message?.chat?.id ||
      update.callback_query?.message?.chat?.id ||
      update.callback_query?.from?.id;
    if (chatId && token) {
      try {
        await sendMessage(chatId, `❌ خطای ربات: ${err.message}`, token);
      } catch (sendErr) {
        console.error(`Failed to send error message: ${sendErr.message}`);
      }
    }
  }
}

async function handleUrl(userId, url, env, origin) {
  try {
    if (url.startsWith("https://rj.app/")) {
      url = await resolveRedirect(url);
      console.log(`Redirected to: ${url}`);
    }

    const { mediaType, mediaName } = parseMediaFromUrl(url);

    if (mediaType === "artist") {
      const artistName = extractArtistName(url);
      await sendMessage(userId, `در حال دریافت آهنگ‌های ${artistName}...`, getBotToken(env));

      let tracks;
      try {
        tracks = await fetchArtistTracks(env, artistName);
      } catch (err) {
        console.error(`Error fetching artist songs: ${err.message}`);
        await sendMessage(userId, `❌ خطا در دریافت آهنگ‌های خواننده: ${err.message}`, getBotToken(env));
        return;
      }

      if (getArtistDeliveryMode(env) === "queue" && env.ARTIST_QUEUE) {
        try {
          await enqueueArtistQueueDelivery(env, userId, artistName, tracks);
          return;
        } catch (err) {
          console.warn(`Queue artist delivery unavailable for ${artistName}: ${err.message}`);
        }
      }

      if (artistJobsEnabled(env)) {
        try {
          await enqueueArtistDelivery(env, userId, artistName, tracks, origin);
        } catch (err) {
          if (!(err instanceof KvWriteLimitError)) {
            throw err;
          }

          console.warn(`KV quota reached; using stateless artist delivery for ${artistName}.`);
          await sendMessage(
            userId,
            "سهمیهٔ نوشتن KV کلادفلر پر شده است؛ تا ریست سهمیه، ارسال بدون پیشرفت قابل ازسرگیری ادامه می‌یابد.",
            getBotToken(env)
          );
          await triggerStatelessArtistRun(
            env,
            origin,
            createStatelessArtistPayload(userId, artistName, tracks)
          );
        }
        return;
      }

      await sendMessage(userId, `${tracks.length} آهنگ پیدا شد. در حال ارسال...`, getBotToken(env));
      await sendArtistTracksAsAudio(userId, tracks, env);
      return;
    }

    if (mediaType === "video" || mediaType === "podcast") {
      await sendMessage(userId, "فقط لینک آهنگ پشتیبانی می‌شود.", getBotToken(env));
      return;
    }

    if (!isSupportedMediaType(mediaType)) {
      await sendMessage(userId, "این نوع رسانه پشتیبانی نمی‌شود!", getBotToken(env));
      return;
    }

    const { urls, title } = await resolveDownloadUrls(env, mediaType, mediaName);
    if (!urls.length) {
      await sendMessage(userId, "این نوع رسانه پشتیبانی نمی‌شود!", getBotToken(env));
      return;
    }

    const track = {
      permlink: mediaName,
      title,
      mediaType,
      urls,
    };

    try {
      await sendTrackToUser(userId, track, env, { preferUrl: true, cacheUploads: true });
    } catch (err) {
      console.error(`Error sending media: ${err.message}`);
      await sendMessage(
        userId,
        `فایل به تلگرام آپلود نشد. از اینجا دانلود کنید: ${urls[0]}`,
        getBotToken(env)
      );
    }
  } catch (err) {
    console.error(`Error in handleUrl: ${err.message}`);
    if (err instanceof KvWriteLimitError) {
      await sendMessage(
        userId,
        "سهمیهٔ نوشتن KV کلادفلر پر شده است. بعد از ریست سهمیهٔ روزانه دوباره تلاش کنید.",
        getBotToken(env)
      );
      return;
    }
    await sendMessage(
      userId,
      `فایل پردازش نشد. از اینجا دانلود کنید: ${url}`,
      getBotToken(env)
    );
  }
}

async function resolveRedirect(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": RJ_DEFAULTS.BROWSER_UA,
        Accept: "*/*",
      },
    });

    if (response.ok) {
      console.log(`Resolved URL: ${response.url}`);
      return response.url;
    }

    throw new Error(`Failed to resolve redirect: HTTP ${response.status}`);
  } catch (err) {
    console.error(`Error resolving redirect: ${err.message}`);
    throw new Error("Could not resolve the redirect.");
  }
}

class TelegramRateLimitError extends Error {
  constructor(retryAfter) {
    super(`Telegram rate limited; retry after ${retryAfter}s`);
    this.name = "TelegramRateLimitError";
    this.retryAfter = retryAfter;
  }
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

async function callTelegram(botToken, method, { body, headers } = {}) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers,
    body,
  });

  const result = await response.json();
  if (!result.ok) {
    if (response.status === 429 || result.error_code === 429) {
      const retryAfter = Number(result.parameters?.retry_after) || RATE_LIMIT_FALLBACK_SECONDS;
      throw new TelegramRateLimitError(retryAfter);
    }
    throw new Error(result.description || `Telegram ${method} failed`);
  }

  return result.result;
}

async function sendDocument(chatId, fileBlob, fileName, botToken) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("document", new File([fileBlob], fileName));

  return callTelegram(botToken, "sendDocument", { body: formData });
}

async function sendAudioByUrl(chatId, audioUrl, botToken) {
  return callTelegram(botToken, "sendAudio", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, audio: audioUrl }),
  });
}

async function sendAudioByFileId(chatId, fileId, botToken) {
  return callTelegram(botToken, "sendAudio", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, audio: fileId }),
  });
}

async function sendAudio(chatId, fileBlob, fileName, botToken) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("audio", new File([fileBlob], fileName));

  return callTelegram(botToken, "sendAudio", { body: formData });
}

async function sendMessage(chatId, text, botToken, extra = {}) {
  return callTelegram(botToken, "sendMessage", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
}

async function answerCallbackQuery(callbackQueryId, botToken, text = "") {
  return callTelegram(botToken, "answerCallbackQuery", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text || undefined,
    }),
  });
}

async function answerInlineQuery(inlineQueryId, results, botToken) {
  return callTelegram(botToken, "answerInlineQuery", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inline_query_id: inlineQueryId,
      results,
      cache_time: 5,
      is_personal: true,
    }),
  });
}

export {
  ARTIST_DELIVERY_DLQ_NAME,
  ARTIST_DELIVERY_QUEUE_NAME,
  HELP_TEXT,
  TelegramRateLimitError,
  buildFallbackUrls,
  cacheTelegramFile,
  callTelegram,
  cancelChatArtistDelivery,
  compactQueuedTrack,
  createQueuedArtistPayload,
  createStatelessArtistPayload,
  deleteCachedTelegramFile,
  enqueueArtistQueueDelivery,
  extractArtistName,
  extractLinkFromMessage,
  extractTracksFromPayload,
  filterUncachedTracks,
  getCachedTelegramFile,
  getArtistQueueDelaySeconds,
  getMaxAudioUrlAttempts,
  getMp3QualityRank,
  getTelegramFileCacheKey,
  handleArtistDeliveryDlq,
  handleHealth,
  handleInlineQuery,
  handleSearchQuery,
  handleUrl,
  hostnameOf,
  isAdminUser,
  isTrackCached,
  normalizeCachePermlink,
  normalizeInput,
  orderSongUrls,
  parseBotCommand,
  parseMediaFromUrl,
  processUpdate,
  resolveSongUrls,
  runStatelessArtistBatch,
  runQueuedArtistMessage,
  runWatchdog,
  searchRadioJavan,
  sendTrackToUser,
  warmArtistMissingTracks,
};
