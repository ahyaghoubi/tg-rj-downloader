import { MAX_SEARCH_ARTISTS, MAX_SEARCH_SONGS, getBotToken } from "../config.js";
import { answerInlineQuery } from "../telegram/send.js";
import { searchRadioJavan } from "./search.js";
import { pushUserRecent, readUserRecents } from "./commands.js";

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

export { handleInlineQuery };
