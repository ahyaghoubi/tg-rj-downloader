import { getBotToken, getMaxAudioUrlAttempts } from "../config.js";
import {
  getFileExtension,
  groupUrlsByQuality,
  hostnameOf,
  isTelegramUrlContentError,
  fetchFileAsBlob,
  resolveSongUrls,
} from "../rj/urls.js";
import {
  cacheTelegramFile,
  deleteCachedTelegramFile,
  getCachedTelegramFile,
} from "../cache/telegram-file.js";
import { TelegramRateLimitError, callTelegram } from "./api.js";

async function sendDocument(chatId, fileBlob, fileName, botToken) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("document", new File([fileBlob], fileName));

  return callTelegram(botToken, "sendDocument", { body: formData });
}

async function sendAudioByUrl(chatId, audioUrl, botToken) {
  return callTelegram(botToken, "sendAudio", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, audio: audioUrl }),
  });
}

async function sendAudioByFileId(chatId, fileId, botToken) {
  return callTelegram(botToken, "sendAudio", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, audio: fileId }),
  });
}

async function sendAudio(chatId, fileBlob, fileName, botToken) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("audio", new File([fileBlob], fileName));

  return callTelegram(botToken, "sendAudio", { body: formData });
}

async function sendMessage(chatId, text, botToken, extra = {}) {
  return callTelegram(botToken, "sendMessage", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
}

async function answerCallbackQuery(callbackQueryId, botToken, text = "") {
  return callTelegram(botToken, "answerCallbackQuery", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text || undefined,
    }),
  });
}

async function answerInlineQuery(inlineQueryId, results, botToken) {
  return callTelegram(botToken, "answerInlineQuery", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inline_query_id: inlineQueryId,
      results,
      cache_time: 5,
      is_personal: true,
    }),
  });
}

async function sendTrackToUser(
  userId,
  track,
  env,
  { preferUrl = true, cacheUploads = true, maxUrlAttempts = null } = {}
) {
  const token = getBotToken(env);
  const urls = resolveSongUrls(track.mediaType, track.permlink, track.urls);
  if (!urls.length) {
    throw new Error(`No candidate URLs for ${track.permlink}`);
  }

  const attemptLimit = maxUrlAttempts || getMaxAudioUrlAttempts(env);
  const deadHosts = new Set();
  let lastError;

  for (const { quality, urls: qualityUrls } of groupUrlsByQuality(urls)) {
    const cached = await getCachedTelegramFile(env, track, quality);
    if (cached) {
      try {
        await sendAudioByFileId(userId, cached.fileId, token);
        console.log(`Cache hit for ${track.permlink} (${quality})`);
        return;
      } catch (err) {
        if (err instanceof TelegramRateLimitError) {
          throw err;
        }
        console.warn(`Cached file_id rejected for ${track.permlink} (${quality}): ${err.message}`);
        await deleteCachedTelegramFile(env, track, quality);
      }
    }

    if (preferUrl) {
      let urlAttempts = 0;
      for (const audioUrl of qualityUrls) {
        if (urlAttempts >= attemptLimit) {
          break;
        }
        const host = hostnameOf(audioUrl);
        if (host && deadHosts.has(host)) {
          continue;
        }

        urlAttempts += 1;
        try {
          const result = await sendAudioByUrl(userId, audioUrl, token);
          if (cacheUploads) {
            await cacheTelegramFile(env, track, quality, result?.audio?.file_id, audioUrl);
          }
          return;
        } catch (err) {
          if (err instanceof TelegramRateLimitError) {
            throw err;
          }
          lastError = err;
          if (host && isTelegramUrlContentError(err)) {
            deadHosts.add(host);
            console.warn(`Marking host ${host} dead for this send after URL content failure`);
          }
          console.warn(`URL send failed for ${audioUrl}: ${err.message}`);
        }
      }
    }

    try {
      // Telegram URL-content failures do not mean the Worker cannot download the same host.
      const { blob, url: sourceUrl } = await fetchFileAsBlob(qualityUrls, {
        maxAttempts: attemptLimit,
        validate: false,
      });
      const fileName = `${track.permlink}.${getFileExtension(sourceUrl)}`;
      const result = await sendAudio(userId, blob, fileName, token);
      if (cacheUploads) {
        await cacheTelegramFile(env, track, quality, result?.audio?.file_id, sourceUrl);
      }
      return;
    } catch (err) {
      if (err instanceof TelegramRateLimitError) {
        throw err;
      }
      lastError = err;
      console.warn(`Upload failed for ${track.permlink} (${quality}): ${err.message}`);
    }
  }

  throw lastError || new Error(`Could not send ${track.permlink}`);
}

export {
  sendDocument,
  sendAudioByUrl,
  sendAudioByFileId,
  sendAudio,
  sendMessage,
  answerCallbackQuery,
  answerInlineQuery,
  sendTrackToUser,
};
