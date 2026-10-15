import { getBotToken } from "../config.js";
import { sendMessage, answerCallbackQuery } from "../telegram/send.js";
import { resolveCallbackData } from "./callback-store.js";
import { handleSearchQuery } from "./search.js";
import { pushUserRecent } from "./commands.js";
import { handleUrl } from "./handle-url.js";
import { presentArtistMenu, startArtistDelivery, enqueueBulkDelivery } from "./artist-menu.js";
import { fetchPlaylistTracks, fetchAlbumTracks } from "../rj/tracks.js";

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
  if (!resolved?.type || resolved.value == null || resolved.value === "") {
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
    await presentArtistMenu(chatId, artistName, env);
    return;
  }

  if (resolved.type === "A") {
    const artistName = resolved.value;
    await pushUserRecent(env, chatId, {
      type: "artist",
      value: artistName,
      label: artistName,
    });
    await startArtistDelivery(chatId, artistName, env);
    return;
  }

  if (resolved.type === "n") {
    const [artistName, limitRaw] = String(resolved.value).split("|");
    const limit = Number(limitRaw);
    if (!artistName || !Number.isFinite(limit) || limit <= 0) {
      await sendMessage(chatId, "این دکمه نامعتبر است. لطفاً دوباره تلاش کنید.", token);
      return;
    }
    await pushUserRecent(env, chatId, {
      type: "artist",
      value: artistName,
      label: artistName,
    });
    await startArtistDelivery(chatId, artistName, env, { limit });
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

  if (resolved.type === "p") {
    const playlistId = resolved.value;
    await pushUserRecent(env, chatId, {
      type: "playlist",
      value: playlistId,
      label: playlistId,
    });
    await sendMessage(chatId, "در حال دریافت پلی‌لیست...", token);
    try {
      const tracks = await fetchPlaylistTracks(env, playlistId);
      await enqueueBulkDelivery(env, chatId, `پلی‌لیست ${playlistId}`, tracks);
    } catch (err) {
      await sendMessage(chatId, `❌ خطا در دریافت پلی‌لیست: ${err.message}`, token);
    }
    return;
  }

  if (resolved.type === "b") {
    const albumPermlink = resolved.value;
    await pushUserRecent(env, chatId, {
      type: "album",
      value: albumPermlink,
      label: albumPermlink,
    });
    await sendMessage(chatId, "در حال دریافت آلبوم...", token);
    try {
      const album = await fetchAlbumTracks(env, albumPermlink);
      const label = album.artist ? `${album.artist} - ${album.title}` : album.title;
      await enqueueBulkDelivery(env, chatId, label, album.tracks);
    } catch (err) {
      await sendMessage(chatId, `❌ خطا در دریافت آلبوم: ${err.message}`, token);
    }
    return;
  }

  await sendMessage(chatId, "عملکرد این دکمه شناخته نشد.", token);
}

export { handleCallbackQuery };
