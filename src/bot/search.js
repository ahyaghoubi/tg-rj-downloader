import { MAX_SEARCH_ARTISTS, MAX_SEARCH_SONGS, getBotToken } from "../config.js";
import { fetchRadioJavanApi } from "../rj/api.js";
import { isSkippedTrack } from "../rj/tracks.js";
import { sendMessage } from "../telegram/send.js";
import { makeCallbackData } from "./callback-store.js";
import { pushUserRecent } from "./commands.js";

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

export { summarizeSearchResults, buildSearchKeyboard, searchRadioJavan, handleSearchQuery };
