import { MAX_SEARCH_ARTISTS, MAX_SEARCH_SONGS, MAX_SEARCH_PLAYLISTS, getBotToken } from "../config.js";
import { answerInlineQuery } from "../telegram/send.js";
import { searchRadioJavan } from "./search.js";
import { pushUserRecent, readUserRecents } from "./commands.js";
import { buildBotStartLink } from "./start-payload.js";
import { orderSongUrls } from "../rj/urls.js";
import { incrementStat } from "../admin/stats.js";

function pickInlineAudioUrl(song) {
  if (song?.link && /^https?:\/\//i.test(song.link)) {
    return orderSongUrls([song.link])[0];
  }
  return null;
}

async function handleInlineQuery(inlineQuery, env) {
  const token = getBotToken(env);
  const query = inlineQuery.query?.trim() || "";
  const userId = inlineQuery.from?.id;
  let artists = [];
  let songs = [];
  let playlists = [];

  try {
    if (query) {
      ({ artists, songs, playlists } = await searchRadioJavan(env, query));
      await incrementStat(env, "inline");
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
        } else if (item.type === "playlist") {
          playlists.push({
            id: item.value,
            title: item.label || item.value,
            count: null,
          });
        }
      }
      artists = artists.slice(0, MAX_SEARCH_ARTISTS);
      songs = songs.slice(0, MAX_SEARCH_SONGS);
      playlists = playlists.slice(0, MAX_SEARCH_PLAYLISTS);
    }
  } catch (err) {
    console.warn(`Inline search failed: ${err.message}`);
  }

  const results = [];

  for (const song of songs) {
    const audioUrl = pickInlineAudioUrl(song);
    const title = song.song || song.title || song.permlink;
    if (audioUrl) {
      results.push({
        type: "audio",
        id: `audio-${String(song.permlink).slice(0, 50)}`,
        audio_url: audioUrl,
        title: String(title).slice(0, 64),
        performer: song.artist ? String(song.artist).slice(0, 64) : undefined,
        audio_duration: song.duration || undefined,
      });
    } else {
      const startLink = await buildBotStartLink(env, "s", song.permlink);
      results.push({
        type: "article",
        id: `s-${String(song.permlink).slice(0, 50)}`,
        title: song.artist ? `${song.artist} - ${title}` : title,
        description: "دانلود در چت ربات",
        input_message_content: {
          message_text: startLink || `https://play.radiojavan.com/song/${encodeURIComponent(song.permlink)}`,
        },
        ...(startLink
          ? {
              reply_markup: {
                inline_keyboard: [[{ text: "⬇️ دانلود", url: startLink }]],
              },
            }
          : {}),
      });
    }
  }

  for (const artist of artists) {
    const startLink = await buildBotStartLink(env, "a", artist.query || artist.name);
    results.push({
      type: "article",
      id: `a-${String(artist.query || artist.name).slice(0, 40)}`,
      title: `خواننده: ${artist.name}`,
      description: "باز کردن منوی دانلود خواننده",
      input_message_content: {
        message_text: startLink || `https://play.radiojavan.com/artist/${encodeURIComponent(artist.query || artist.name)}`,
      },
      ...(startLink
        ? {
            reply_markup: {
              inline_keyboard: [[{ text: "🎤 انتخاب آهنگ/پلی‌لیست", url: startLink }]],
            },
          }
        : {}),
    });
  }

  for (const playlist of playlists) {
    const startLink = await buildBotStartLink(env, "p", playlist.id);
    const count = playlist.count ? ` (${playlist.count})` : "";
    results.push({
      type: "article",
      id: `p-${String(playlist.id).slice(0, 40)}`,
      title: `پلی‌لیست: ${playlist.title}${count}`,
      description: "دانلود همهٔ آهنگ‌های پلی‌لیست",
      input_message_content: {
        message_text: startLink || `https://play.radiojavan.com/playlist/mp3/${encodeURIComponent(playlist.id)}`,
      },
      ...(startLink
        ? {
            reply_markup: {
              inline_keyboard: [[{ text: "📋 دانلود پلی‌لیست", url: startLink }]],
            },
          }
        : {}),
    });
  }

  if (!results.length) {
    results.push({
      type: "article",
      id: "empty",
      title: query ? "نتیجه‌ای نیست" : "برای جستجو در رادیو جوان بنویسید",
      description: query ? `چیزی برای ${query} پیدا نشد` : "نام خواننده، آهنگ یا پلی‌لیست را امتحان کنید",
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

export { handleInlineQuery };
