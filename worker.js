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
    for (const message of batch.messages) {
      try {
        await runQueuedArtistMessage(env, message.body);
        message.ack();
      } catch (err) {
        if (err instanceof TelegramRateLimitError) {
          const delaySeconds = Math.max(err.retryAfter || RATE_LIMIT_FALLBACK_SECONDS, 1);
          console.warn(`Queue artist delivery rate limited; retrying in ${delaySeconds}s`);
          message.retry({ delaySeconds });
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

const MEDIA_HOSTS = [
  "host2.rj-mw1.com",
  "host1.rj-mw1.com",
  "host2.rjapp-content.app",
  "host1.rjapp-content.app",
];

const MEDIA_PATH_TEMPLATES = {
  song: [
    ["media/mp3/mp3-320", "mp3"],
    ["media/mp3/mp3-256", "mp3"],
  ],
};

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

  for (const url of buildFallbackUrls(mediaType, permlink)) {
    push(url);
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

  const normalized = normalizeInput(message.text);
  if (
    normalized.startsWith("http") ||
    normalized.includes("radiojavan.com") ||
    normalized.startsWith("rj.app")
  ) {
    return normalized;
  }

  if (message.entities) {
    for (const entity of message.entities) {
      if (entity.type === "url") {
        return normalizeInput(message.text.slice(entity.offset, entity.offset + entity.length));
      }
    }
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
  for (const host of MEDIA_HOSTS) {
    for (const [path, ext] of templates) {
      for (const name of names) {
        const url = `https://${host}/${path}/${name}.${ext}`;
        if (!urls.includes(url)) {
          urls.push(url);
        }
      }
    }
  }
  return urls;
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
    let response = await fetch(url, { method: "HEAD", headers, redirect: "follow" });
    if (!response.ok) {
      response = await fetch(url, { method: "GET", headers, redirect: "follow" });
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

async function fetchFileAsBlob(urls) {
  for (const url of urls) {
    try {
      if (!(await isValidMediaUrl(url))) {
        continue;
      }

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": RJ_DEFAULTS.BROWSER_UA,
          Referer: url,
          Accept: "*/*",
        },
        redirect: "follow",
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

  let summary = `Done. Sent ${sent}/${tracks.length} songs.`;
  if (failed.length) {
    summary += `\n\nCould not fetch:\n${failed.join("\n")}`;
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

function getTelegramFileCacheKey(track, quality) {
  return `${FILE_CACHE_PREFIX}:song:${track.mediaType}:${track.permlink}:${quality}`;
}

async function getCachedTelegramFile(env, track, quality) {
  const kv = getFileCacheStore(env);
  if (!kv) {
    return null;
  }

  const key = getTelegramFileCacheKey(track, quality);
  try {
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

  const key = getTelegramFileCacheKey(track, quality);
  try {
    await kv.delete(key);
  } catch (err) {
    console.warn(`Cache delete failed for ${key}: ${err.message}`);
  }
}

async function sendTrackToUser(userId, track, env, { preferUrl = false, cacheUploads = true } = {}) {
  const token = getBotToken(env);
  const urls = resolveSongUrls(track.mediaType, track.permlink, track.urls);
  if (!urls.length) {
    throw new Error(`No candidate URLs for ${track.permlink}`);
  }

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
      for (const audioUrl of qualityUrls) {
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
          console.warn(`URL send failed for ${audioUrl}: ${err.message}`);
        }
      }
    }

    try {
      const { blob, url: sourceUrl } = await fetchFileAsBlob(qualityUrls);
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
      `You already have a delivery in progress. Queued ${artistName} (${tracks.length} songs); it will start after the current one finishes.`,
      token
    );
    return;
  }

  const existingQueuedId = await kv.get(chatQueuedKey(chatId));
  if (existingQueuedId) {
    await replaceChatQueuedJob(env, chatId, job);
    await sendMessage(
      chatId,
      `Updated your queued request to ${artistName} (${tracks.length} songs).`,
      token
    );
    await promoteQueuedJobs(env, origin);
    return;
  }

  const activeCount = (await readJsonArray(kv, ACTIVE_INDEX_KEY)).length;
  if (activeCount < getMaxActiveArtistJobs(env)) {
    await sendMessage(
      chatId,
      `Found ${tracks.length} songs for ${artistName}. Sending...`,
      token
    );
    await activateArtistJob(env, job, origin);
    return;
  }

  await queueArtistJob(env, job);
  await putKv(kv, chatQueuedKey(chatId), job.id);
  await sendMessage(
    chatId,
    `The bot is busy right now. Your request for ${artistName} (${tracks.length} songs) has been queued and will start automatically.`,
    token
  );
}

async function enqueueArtistQueueDelivery(env, chatId, artistName, tracks) {
  const token = getBotToken(env);
  await enqueueArtistQueueMessage(env, createQueuedArtistPayload(chatId, artistName, tracks));
  await sendMessage(chatId, `Found ${tracks.length} songs for ${artistName}. Sending...`, token);
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

function createQueuedArtistPayload(chatId, artistName, tracks) {
  return {
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
        cacheUploads: shouldCacheArtistUploads(env),
      });
      payload.sentTrackKeys.push(trackKey);
      payload.sent += 1;
      payload.nextIndex += 1;
      console.log(
        `Queue artist delivery ${payload.artistName}: sent ${payload.sent}/${payload.total}`
      );
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
    let summary = `Done with ${payload.artistName}. Sent ${payload.sent}/${payload.total} songs.`;
    if (payload.failed.length) {
      summary += `\n\nCould not send:\n${payload.failed.join("\n")}`;
    }
    await sendMessage(payload.chatId, summary, token);
    console.log(`Queue artist delivery ${payload.artistName}: completed`);
    return;
  }

  await enqueueArtistQueueMessage(env, payload);
  console.log(
    `Queue artist delivery ${payload.artistName}: enqueued index ${payload.nextIndex + 1}/${payload.total}`
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
          `Telegram rate-limited delivery. Retrying later is needed for ${payload.artistName}.`,
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
    let summary = `Done with ${payload.artistName}. Sent ${payload.sent}/${payload.total} songs.`;
    if (payload.failed.length) {
      summary += `\n\nCould not send:\n${payload.failed.join("\n")}`;
    }
    await sendMessage(payload.chatId, summary, token);
    return;
  }

  const triggered = await triggerStatelessArtistRun(env, origin, payload);
  if (!triggered) {
    await sendMessage(
      payload.chatId,
      `Artist delivery paused at ${payload.sent}/${payload.total} songs because the temporary no-KV continuation could not be started.`,
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
          "Cloudflare KV write quota has been reached, so artist delivery is paused until the daily quota resets.",
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

  let summary = `Done with ${job.artistName}. Sent ${job.sent}/${job.total} songs.`;
  if (job.failed.length) {
    summary += `\n\nCould not send:\n${job.failed.join("\n")}`;
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

async function processUpdate(update, env, origin) {
  const token = getBotToken(env);
  const message = update.message || update.edited_message;

  try {
    if (!token) {
      console.error("BOT_TOKEN not configured");
      return;
    }

    if (!message) {
      return;
    }

    const chatId = message.chat?.id;
    if (!chatId) {
      return;
    }

    const text = message.text?.trim();
    const link = extractLinkFromMessage(message);

    if (text === "/start") {
      await sendMessage(chatId, "Welcome to the bot! 🚀", token);
      return;
    }

    if (link) {
      await handleUrl(chatId, link, env, origin);
      return;
    }

    if (text) {
      await sendMessage(chatId, "Invalid input! Please send a valid Radio Javan link.", token);
    }
  } catch (err) {
    console.error(`processUpdate failed: ${err.message}`);
    const chatId = message?.chat?.id;
    if (chatId && token) {
      try {
        await sendMessage(chatId, `❌ Bot error: ${err.message}`, token);
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
      await sendMessage(userId, `Fetching songs for ${artistName}...`, getBotToken(env));

      let tracks;
      try {
        tracks = await fetchArtistTracks(env, artistName);
      } catch (err) {
        console.error(`Error fetching artist songs: ${err.message}`);
        await sendMessage(userId, `❌ Error fetching artist songs: ${err.message}`, getBotToken(env));
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
            "Cloudflare KV write quota is reached, so delivery will continue without resumable progress until the quota resets.",
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

      await sendMessage(userId, `Found ${tracks.length} songs. Sending...`, getBotToken(env));
      await sendArtistTracksAsAudio(userId, tracks, env);
      return;
    }

    if (mediaType === "video" || mediaType === "podcast") {
      await sendMessage(userId, "Only song links are supported.", getBotToken(env));
      return;
    }

    if (!isSupportedMediaType(mediaType)) {
      await sendMessage(userId, "Unsupported media type!", getBotToken(env));
      return;
    }

    const { urls, title } = await resolveDownloadUrls(env, mediaType, mediaName);
    if (!urls.length) {
      await sendMessage(userId, "Unsupported media type!", getBotToken(env));
      return;
    }

    const track = {
      permlink: mediaName,
      title,
      mediaType,
      urls,
    };

    try {
      await sendTrackToUser(userId, track, env);
    } catch (err) {
      console.error(`Error sending media: ${err.message}`);
      await sendMessage(
        userId,
        `The file could not be uploaded to Telegram. Download it here: ${urls[0]}`,
        getBotToken(env)
      );
    }
  } catch (err) {
    console.error(`Error in handleUrl: ${err.message}`);
    if (err instanceof KvWriteLimitError) {
      await sendMessage(
        userId,
        "Cloudflare KV write quota has been reached. Please try again after the daily quota resets.",
        getBotToken(env)
      );
      return;
    }
    await sendMessage(
      userId,
      `The file could not be processed. Download it here: ${url}`,
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

async function sendMessage(chatId, text, botToken) {
  return callTelegram(botToken, "sendMessage", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
