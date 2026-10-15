import {
  MAX_SEARCH_ARTISTS,
  MAX_SEARCH_SONGS,
  MAX_SEARCH_PLAYLISTS,
  getBotToken,
} from "../config.js";
import { fetchRadioJavanApi } from "../rj/api.js";
import { extractPlaylistsFromPayload, isSkippedTrack } from "../rj/tracks.js";
import { sendMessage } from "../telegram/send.js";
import { makeCallbackData } from "./callback-store.js";
import { pushUserRecent } from "./commands.js";
import { recordUserActivity } from "../admin/users.js";
import { incrementStat } from "../admin/stats.js";

function summarizeSearchResults(artists, songs, playlists = []) {
  const lines = ["نتایج جستجو — روی دکمه بزنید:"];
  if (artists.length) {
    lines.push("", "خواننده‌ها:");
    for (const artist of artists) {
      lines.push(`• ${artist.name}`);
    }
  }
  if (playlists.length) {
    lines.push("", "پلی‌لیست‌ها:");
    for (const playlist of playlists) {
      const count = playlist.count ? ` (${playlist.count})` : "";
      lines.push(`• ${playlist.title}${count}`);
    }
  }
  if (songs.length) {
    lines.push("", "آهنگ‌ها:");
    for (const song of songs) {
      lines.push(`• ${song.artist ? `${song.artist} - ` : ""}${song.song || song.title || song.permlink}`);
    }
  }
  if (!artists.length && !songs.length && !playlists.length) {
    return "آهنگ، خواننده یا پلی‌لیستی پیدا نشد.";
  }
  return lines.join("\n");
}

async function buildSearchKeyboard(env, artists, songs, playlists = []) {
  const rows = [];
  for (const artist of artists) {
    rows.push([
      {
        text: `🎤 ${artist.name}`.slice(0, 64),
        callback_data: await makeCallbackData(env, "a", artist.query || artist.name),
      },
    ]);
  }
  for (const playlist of playlists) {
    const count = playlist.count ? ` (${playlist.count})` : "";
    rows.push([
      {
        text: `📋 ${playlist.title}${count}`.slice(0, 64),
        callback_data: await makeCallbackData(env, "p", playlist.id),
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
    return { artists: [], songs: [], playlists: [] };
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
    const duration = Number(item.duration);
    songs.push({
      permlink: item.permlink,
      title: item.title || item.song || item.permlink,
      song: item.song || item.title || item.permlink,
      artist: item.artist || "",
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
      photo: item.photo || item.thumbnail || null,
      link: item.link || item.hq_link || item.lq_link || null,
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

  const playlists = extractPlaylistsFromPayload(data).slice(0, MAX_SEARCH_PLAYLISTS);

  return {
    artists: artists.slice(0, MAX_SEARCH_ARTISTS),
    songs: songs.slice(0, MAX_SEARCH_SONGS),
    playlists,
  };
}

async function handleSearchQuery(chatId, query, env) {
  const token = getBotToken(env);
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    await sendMessage(chatId, "نحوهٔ استفاده: /search <آهنگ، خواننده یا پلی‌لیست>", token);
    return;
  }

  await sendMessage(chatId, `در حال جستجو برای «${trimmed}»...`, token);
  const { artists, songs, playlists } = await searchRadioJavan(env, trimmed);
  await incrementStat(env, "searches");
  await pushUserRecent(env, chatId, { type: "search", value: trimmed, label: trimmed });
  await recordUserActivity(env, chatId, { type: "search", detail: trimmed });

  if (!artists.length && !songs.length && !playlists.length) {
    await sendMessage(chatId, `نتیجه‌ای برای «${trimmed}» پیدا نشد.`, token);
    return;
  }

  const keyboard = await buildSearchKeyboard(env, artists, songs, playlists);
  await sendMessage(chatId, summarizeSearchResults(artists, songs, playlists), token, {
    reply_markup: keyboard,
  });
}

export { summarizeSearchResults, buildSearchKeyboard, searchRadioJavan, handleSearchQuery };
