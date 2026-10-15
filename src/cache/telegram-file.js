import { FILE_CACHE_PREFIX, getFileCacheStore, putKv, KvWriteLimitError } from "../config.js";
import { getFileExtension, stripUrlQuery } from "../rj/urls.js";

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

export {
  normalizeCachePermlink,
  getTelegramFileCacheKey,
  getCachedTelegramFile,
  cacheTelegramFile,
  deleteCachedTelegramFile,
  isTrackCached,
  filterUncachedTracks,
};
