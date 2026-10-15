import { fetchRadioJavanApi } from "./api.js";
import { collectRawUrlsFromTrack, resolveSongUrls } from "./urls.js";

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

export {
  API_MEDIA_TYPES,
  isSupportedMediaType,
  isSkippedTrack,
  trackFromApiItem,
  extractTracksFromPayload,
  fetchArtistTracks,
  fetchMediaTrack,
  resolveDownloadUrls,
};
