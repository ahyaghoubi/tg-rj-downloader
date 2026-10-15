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

async function processUpdate(update, env, origin) {
  const token = getBotToken(env);

  try {
    if (!token) {
      console.error("BOT_TOKEN not configured");
      return;
    }

    if (update.inline_query) {
      await handleInlineQuery(update.inline_query, env);
      return;
    }

    if (update.callback_query) {
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

    const userId = message.from?.id || chatId;
    const text = message.text?.trim();
    const link = extractLinkFromMessage(message);
    const command = parseBotCommand(text || "");

    if (command?.name === "start") {
      await sendMessage(
        chatId,
        "به ربات دانلود رادیو جوان خوش آمدید.\n\nلینک آهنگ/خواننده بفرستید، از /search استفاده کنید، یا حالت اینلاین را امتحان کنید.\n\n" +
          HELP_TEXT,
        token
      );
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
        const parsed = parseMediaFromUrl(
          link.startsWith("https://rj.app/") ? link : normalizeInput(link)
        );
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
    if (chatId && token) {
      try {
        await sendMessage(chatId, `❌ خطای ربات: ${err.message}`, token);
      } catch (sendErr) {
        console.error(`Failed to send error message: ${sendErr.message}`);
      }
    }
  }
}

export { processUpdate };
