import {
  RJ_DEFAULTS,
  MEDIA_HOSTS,
  FALLBACK_HOST_LIMIT,
  MEDIA_PATH_TEMPLATES,
  DEFAULT_MAX_AUDIO_URL_ATTEMPTS,
  MEDIA_PROBE_TIMEOUT_MS,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  MIN_FILE_SIZE,
} from "../config.js";

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

function decodePathSegment(value) {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, " "));
  } catch {
    return String(value || "");
  }
}

/** Decode artist names from URLs or stale KV locks (may still be percent-encoded). */
function normalizeArtistName(value) {
  let current = String(value || "").trim();
  for (let i = 0; i < 3; i++) {
    const next = decodePathSegment(current);
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

function artistNamesEqual(a, b) {
  return normalizeArtistName(a).toLowerCase() === normalizeArtistName(b).toLowerCase();
}

function parseMediaFromUrl(link) {
  const parsed = new URL(link);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`Invalid URL format: ${link}`);
  }
  return {
    mediaType: decodePathSegment(segments[0]),
    mediaName: decodePathSegment(segments[1]),
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

export {
  upgradeTo320Url,
  getMp3QualityRank,
  orderSongUrls,
  collectRawUrlsFromTrack,
  resolveSongUrls,
  decodePathSegment,
  normalizeArtistName,
  artistNamesEqual,
  parseMediaFromUrl,
  extractArtistName,
  buildFallbackUrls,
  hostnameOf,
  isTelegramUrlContentError,
  normalizeInput,
  extractLinkFromMessage,
  getFileExtension,
  getUrlQuality,
  groupUrlsByQuality,
  stripUrlQuery,
  isValidMediaUrl,
  fetchFileAsBlob,
  resolveRedirect,
};
