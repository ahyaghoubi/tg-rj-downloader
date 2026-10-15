import { ARTIST_LATEST_OPTIONS, MAX_ARTIST_PLAYLIST_BUTTONS } from "../config.js";
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
  const duration = Number(item.duration);
  const photo =
    (typeof item.photo === "string" && item.photo) ||
    (typeof item.thumbnail === "string" && item.thumbnail) ||
    (typeof item.photo_player === "string" && item.photo_player) ||
    null;

  return {
    permlink: item.permlink,
    title: item.song || item.title || item.permlink,
    artist: item.artist || item.artist_farsi || "",
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    photo,
    createdAt: item.created_at || item.date || null,
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

function normalizePlaylistEntry(item) {
  const playlist = item?.playlist && typeof item.playlist === "object" ? item.playlist : item;
  if (!playlist || typeof playlist !== "object") {
    return null;
  }
  const id = playlist.id || playlist.permlink;
  if (!id) {
    return null;
  }
  const subtype = String(playlist.subtype || "mp3").toLowerCase();
  if (subtype && subtype !== "mp3") {
    return null;
  }
  return {
    id: String(id),
    title: playlist.title || playlist.name || String(id),
    count: Number(playlist.items_count || playlist.count) || null,
    createdBy: playlist.created_by || playlist.created_title || item?.name || "",
  };
}

function extractPlaylistsFromPayload(data) {
  const playlists = [];
  const seen = new Set();

  const push = (item) => {
    const normalized = normalizePlaylistEntry(item);
    if (!normalized) {
      return;
    }
    const key = normalized.id.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    playlists.push(normalized);
  };

  if (Array.isArray(data)) {
    for (const item of data) {
      push(item);
    }
    return playlists;
  }

  if (!data || typeof data !== "object") {
    return playlists;
  }

  for (const item of data.playlists || []) {
    push(item);
  }
  for (const item of data.top || []) {
    if (item?.type === "playlist" || item?.playlist) {
      push(item);
    }
  }

  return playlists;
}

function sortTracksByNewest(tracks) {
  return [...tracks].sort((a, b) => {
    const aMs = Date.parse(a?.createdAt || "") || 0;
    const bMs = Date.parse(b?.createdAt || "") || 0;
    return bMs - aMs;
  });
}

function selectArtistTracks(tracks, limit = null) {
  if (!limit || limit <= 0 || limit >= tracks.length) {
    return tracks;
  }
  return sortTracksByNewest(tracks).slice(0, limit);
}

async function fetchArtistCatalog(env, artistName) {
  const refererPath = `/artist/${artistName}/songs`;
  const endpoints = [
    `/api/p/artist?query=${encodeURIComponent(artistName)}&v=2`,
    `/api/p/artist?query=${encodeURIComponent(artistName)}`,
  ];

  let lastError;
  let best = { tracks: [], playlists: [] };
  for (const endpoint of endpoints) {
    try {
      const data = await fetchRadioJavanApi(env, endpoint, refererPath);
      const tracks = extractTracksFromPayload(data);
      const playlists = extractPlaylistsFromPayload(data).slice(0, MAX_ARTIST_PLAYLIST_BUTTONS);
      if (tracks.length || playlists.length) {
        return { tracks, playlists, latestOptions: ARTIST_LATEST_OPTIONS };
      }
      best = { tracks, playlists };
    } catch (err) {
      lastError = err;
      console.warn(`Artist API attempt failed (${endpoint}): ${err.message}`);
    }
  }

  if (best.tracks.length || best.playlists.length) {
    return { ...best, latestOptions: ARTIST_LATEST_OPTIONS };
  }

  throw lastError || new Error("No tracks found for artist");
}

async function fetchArtistTracks(env, artistName) {
  const { tracks } = await fetchArtistCatalog(env, artistName);
  if (!tracks.length) {
    throw new Error("No tracks found for artist");
  }
  return tracks;
}

async function fetchPlaylistTracks(env, playlistId) {
  const id = String(playlistId || "").trim();
  if (!id) {
    throw new Error("Missing playlist id");
  }

  const data = await fetchRadioJavanApi(
    env,
    `/api/p/mp3_playlist?id=${encodeURIComponent(id)}`,
    `/playlist/mp3/${encodeURIComponent(id)}`
  );

  const tracks = Array.isArray(data)
    ? data.map((item) => trackFromApiItem(item, "song")).filter(Boolean)
    : extractTracksFromPayload(data);

  if (!tracks.length) {
    throw new Error("No tracks found for playlist");
  }
  return tracks;
}

async function fetchAlbumTracks(env, albumPermlink) {
  const permlink = String(albumPermlink || "").trim();
  if (!permlink) {
    throw new Error("Missing album id");
  }

  const data = await fetchRadioJavanApi(
    env,
    `/api/p/mp3?id=${encodeURIComponent(permlink)}`,
    `/album/${encodeURIComponent(permlink)}`
  );

  if (Array.isArray(data?.album_tracks) && data.album_tracks.length) {
    const tracks = data.album_tracks.map((item) => trackFromApiItem(item, "song")).filter(Boolean);
    if (tracks.length) {
      return {
        tracks,
        title: data.album_album || data.album || data.song || permlink,
        artist: data.album_artist || data.artist || "",
      };
    }
  }

  const single = trackFromApiItem(data, "song");
  if (single) {
    return {
      tracks: [single],
      title: data.album_album || data.album || single.title,
      artist: data.album_artist || data.artist || single.artist || "",
    };
  }

  throw new Error("No tracks found for album");
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
  return {
    urls,
    title: track?.title || permlink,
    artist: track?.artist || "",
    duration: track?.duration || null,
    photo: track?.photo || null,
  };
}

export {
  API_MEDIA_TYPES,
  isSupportedMediaType,
  isSkippedTrack,
  trackFromApiItem,
  extractTracksFromPayload,
  extractPlaylistsFromPayload,
  normalizePlaylistEntry,
  sortTracksByNewest,
  selectArtistTracks,
  fetchArtistCatalog,
  fetchArtistTracks,
  fetchPlaylistTracks,
  fetchAlbumTracks,
  fetchMediaTrack,
  resolveDownloadUrls,
};
