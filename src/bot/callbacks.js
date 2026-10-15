import { getBotToken } from "../config.js";
import { sendMessage, answerCallbackQuery } from "../telegram/send.js";
import { resolveCallbackData } from "./callback-store.js";
import { handleSearchQuery } from "./search.js";
import { pushUserRecent } from "./commands.js";
import { handleUrl } from "./handle-url.js";

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
  if (!resolved?.type || !resolved?.value) {
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
    await handleUrl(chatId, `https://play.radiojavan.com/artist/${encodeURIComponent(artistName)}`, env, origin);
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

  await sendMessage(chatId, "عملکرد این دکمه شناخته نشد.", token);
}

export { handleCallbackQuery };
