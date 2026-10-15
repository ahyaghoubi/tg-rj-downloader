import { getBotToken } from "../config.js";
import { HELP_TEXT } from "../messages/fa.js";
import { extractLinkFromMessage, normalizeInput, parseMediaFromUrl } from "../rj/urls.js";
import { sendMessage } from "../telegram/send.js";
import {
  parseBotCommand,
  cancelChatArtistDelivery,
  handleRecentCommand,
  handleStatusCommand,
  pushUserRecent,
} from "./commands.js";
import { handleSearchQuery } from "./search.js";
import { handleInlineQuery } from "./inline.js";
import { handleCallbackQuery } from "./callbacks.js";
import { handleUrl } from "./handle-url.js";
import { resolveStartPayload } from "./start-payload.js";
import { presentArtistMenu, startArtistDelivery, enqueueBulkDelivery } from "./artist-menu.js";
import { fetchPlaylistTracks, fetchAlbumTracks } from "../rj/tracks.js";
import { isUserBanned, isUserAllowed, touchUser } from "../admin/users.js";
import { incrementStat } from "../admin/stats.js";
import { recordAdminError } from "../admin/ops-log.js";
import { loadRuntimeConfig } from "../admin/runtime-config.js";

async function handleStartPayload(chatId, payload, env, origin) {
  const resolved = await resolveStartPayload(env, payload);
  if (!resolved?.type || resolved.value == null || resolved.value === "") {
    await sendMessage(
      chatId,
      "به ربات دانلود رادیو جوان خوش آمدید.\n\nلینک آهنگ/خواننده/پلی‌لیست بفرستید، از /search استفاده کنید، یا حالت اینلاین را امتحان کنید.\n\n" +
        HELP_TEXT,
      getBotToken(env)
    );
    return;
  }

  const { type, value } = resolved;

  if (type === "s") {
    await pushUserRecent(env, chatId, { type: "song", value, label: value });
    await handleUrl(chatId, `https://play.radiojavan.com/song/${encodeURIComponent(value)}`, env, origin);
    return;
  }

  if (type === "a") {
    await pushUserRecent(env, chatId, { type: "artist", value, label: value });
    await presentArtistMenu(chatId, value, env);
    return;
  }

  if (type === "A") {
    await pushUserRecent(env, chatId, { type: "artist", value, label: value });
    await startArtistDelivery(chatId, value, env);
    return;
  }

  if (type === "n") {
    const [artistName, limitRaw] = String(value).split("|");
    const limit = Number(limitRaw);
    if (!artistName || !Number.isFinite(limit) || limit <= 0) {
      await sendMessage(chatId, "لینک شروع نامعتبر است.", getBotToken(env));
      return;
    }
    await pushUserRecent(env, chatId, { type: "artist", value: artistName, label: artistName });
    await startArtistDelivery(chatId, artistName, env, { limit });
    return;
  }

  if (type === "p") {
    await pushUserRecent(env, chatId, { type: "playlist", value, label: value });
    await sendMessage(chatId, "در حال دریافت پلی‌لیست...", getBotToken(env));
    try {
      const tracks = await fetchPlaylistTracks(env, value);
      await enqueueBulkDelivery(env, chatId, `پلی‌لیست ${value}`, tracks);
    } catch (err) {
      await sendMessage(chatId, `❌ خطا در دریافت پلی‌لیست: ${err.message}`, getBotToken(env));
    }
    return;
  }

  if (type === "b") {
    await pushUserRecent(env, chatId, { type: "album", value, label: value });
    await sendMessage(chatId, "در حال دریافت آلبوم...", getBotToken(env));
    try {
      const album = await fetchAlbumTracks(env, value);
      const label = album.artist ? `${album.artist} - ${album.title}` : album.title;
      await enqueueBulkDelivery(env, chatId, label, album.tracks);
    } catch (err) {
      await sendMessage(chatId, `❌ خطا در دریافت آلبوم: ${err.message}`, getBotToken(env));
    }
    return;
  }

  await sendMessage(
    chatId,
    "به ربات دانلود رادیو جوان خوش آمدید.\n\n" + HELP_TEXT,
    getBotToken(env)
  );
}

async function denyAccess(chatId, token, { privateOnly = false, isPrivate = true } = {}) {
  if (privateOnly && !isPrivate) {
    return;
  }
  await sendMessage(chatId, "دسترسی شما به این ربات محدود شده است.", token);
}

async function processUpdate(update, env, origin) {
  const token = getBotToken(env);

  try {
    if (!token) {
      console.error("BOT_TOKEN not configured");
      return;
    }

    await loadRuntimeConfig(env);

    if (update.inline_query) {
      const from = update.inline_query.from;
      if (from?.id && (await isUserBanned(env, from.id))) {
        return;
      }
      if (from?.id && !(await isUserAllowed(env, from.id))) {
        return;
      }
      await touchUser(env, from);
      await handleInlineQuery(update.inline_query, env);
      return;
    }

    if (update.callback_query) {
      const from = update.callback_query.from;
      const chatId = update.callback_query.message?.chat?.id || from?.id;
      if (chatId && (await isUserBanned(env, chatId))) {
        return;
      }
      if (from?.id && from.id !== chatId && (await isUserBanned(env, from.id))) {
        return;
      }
      if (chatId && !(await isUserAllowed(env, chatId))) {
        return;
      }
      if (from?.id && from.id !== chatId && !(await isUserAllowed(env, from.id))) {
        return;
      }
      await touchUser(env, from, update.callback_query.message?.chat);
      await handleCallbackQuery(update.callback_query, env, origin);
      return;
    }

    const message = update.message || update.edited_message;
    if (!message) {
      return;
    }

    const chatId = message.chat?.id;
    if (!chatId) {
      return;
    }

    await touchUser(env, message.from, message.chat);
    await incrementStat(env, "messages");

    const isPrivate = message.chat?.type === "private" || !message.chat?.type;

    if (await isUserBanned(env, chatId)) {
      await denyAccess(chatId, token, { privateOnly: true, isPrivate });
      return;
    }

    if (!(await isUserAllowed(env, chatId))) {
      await denyAccess(chatId, token, { privateOnly: true, isPrivate });
      return;
    }

    if (message.from?.id && String(message.from.id) !== String(chatId)) {
      if (await isUserBanned(env, message.from.id)) {
        return;
      }
      if (!(await isUserAllowed(env, message.from.id))) {
        return;
      }
    }

    const userId = message.from?.id || chatId;
    const text = message.text?.trim();
    const link = extractLinkFromMessage(message);
    const command = parseBotCommand(text || "");

    if (command?.name === "start") {
      await handleStartPayload(chatId, command.arg, env, origin);
      return;
    }

    if (command?.name === "help") {
      await sendMessage(chatId, HELP_TEXT, token);
      return;
    }

    if (command?.name === "cancel") {
      await cancelChatArtistDelivery(env, chatId);
      return;
    }

    if (command?.name === "status") {
      await handleStatusCommand(chatId, userId, env);
      return;
    }

    if (command?.name === "recent" || command?.name === "recents") {
      await handleRecentCommand(chatId, env);
      return;
    }

    if (command?.name === "search") {
      await handleSearchQuery(chatId, command.arg, env);
      return;
    }

    if (link) {
      try {
        let resolvedLink = link;
        if (link.startsWith("https://rj.app/")) {
          // Short links are resolved inside handleUrl; skip recent typing here.
        } else {
          const parsed = parseMediaFromUrl(normalizeInput(link));
          if (parsed.mediaType === "artist") {
            await pushUserRecent(env, chatId, {
              type: "artist",
              value: parsed.mediaName,
              label: parsed.mediaName,
            });
          } else if (parsed.mediaType === "song") {
            await pushUserRecent(env, chatId, {
              type: "song",
              value: parsed.mediaName,
              label: parsed.mediaName,
            });
          } else if (parsed.mediaType === "playlist") {
            await pushUserRecent(env, chatId, {
              type: "playlist",
              value: parsed.mediaName,
              label: parsed.mediaName,
            });
          } else if (parsed.mediaType === "album") {
            await pushUserRecent(env, chatId, {
              type: "album",
              value: parsed.mediaName,
              label: parsed.mediaName,
            });
          }
        }
      } catch (_) {
        // Link may be a short URL; handleUrl will resolve it.
      }
      await handleUrl(chatId, link, env, origin);
      return;
    }

    if (text) {
      await handleSearchQuery(chatId, text, env);
    }
  } catch (err) {
    console.error(`processUpdate failed: ${err.message}`);
    const chatId =
      update.message?.chat?.id ||
      update.edited_message?.chat?.id ||
      update.callback_query?.message?.chat?.id ||
      update.callback_query?.from?.id;
    await recordAdminError(env, {
      where: "processUpdate",
      message: err.message,
      chatId,
    });
    if (chatId && token) {
      try {
        await sendMessage(chatId, `❌ خطای ربات: ${err.message}`, token);
      } catch (sendErr) {
        console.error(`Failed to send error message: ${sendErr.message}`);
      }
    }
  }
}

export { processUpdate, handleStartPayload };
