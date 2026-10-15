import { ARTIST_DELIVERY_DLQ_NAME, resolveArtistQueueDelaySeconds } from "./config.js";
import { handleHttpRequest } from "./routes/http.js";
import {
  enqueueArtistQueueMessage,
  normalizeQueuePayload,
  runQueuedArtistMessage,
} from "./delivery/queue.js";
import { handleArtistDeliveryDlq } from "./delivery/dlq.js";
import { TelegramRateLimitError } from "./telegram/api.js";
import { recordAdminError } from "./admin/ops-log.js";
import { loadRuntimeConfig, isQueuePaused } from "./admin/runtime-config.js";

const worker = {
  async fetch(request, env, ctx) {
    try {
      await loadRuntimeConfig(env);
      return await handleHttpRequest(request, env, ctx);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      return new Response("Error: Unable to process your request.", {
        status: 500,
      });
    }
  },

  async scheduled() {
    // Queue-only: legacy KV job watchdog removed.
  },

  async queue(batch, env, ctx) {
    await loadRuntimeConfig(env);

    if (batch.queue === ARTIST_DELIVERY_DLQ_NAME) {
      for (const message of batch.messages) {
        try {
          await handleArtistDeliveryDlq(env, message.body);
        } catch (err) {
          console.error(`Artist delivery DLQ handling failed: ${err.message}`);
        }
        message.ack();
      }
      return;
    }

    if (isQueuePaused(env)) {
      for (const message of batch.messages) {
        message.retry({ delaySeconds: 30 });
      }
      return;
    }

    for (const message of batch.messages) {
      try {
        await runQueuedArtistMessage(env, message.body);
        message.ack();
      } catch (err) {
        if (err instanceof TelegramRateLimitError) {
          const payload = normalizeQueuePayload(message.body) || {};
          const delaySeconds = resolveArtistQueueDelaySeconds(env, payload, {
            rateLimited: true,
            retryAfter: err.retryAfter,
          });
          console.warn(
            `Queue artist delivery rate limited; requeue with boost=${payload.rateLimitBoost} delay=${delaySeconds}s`
          );
          try {
            await enqueueArtistQueueMessage(env, payload, { delaySeconds });
            message.ack();
          } catch (enqueueErr) {
            console.warn(`Rate-limit requeue failed: ${enqueueErr.message}`);
            message.retry({ delaySeconds });
          }
          continue;
        }

        console.error(`Queue artist delivery failed: ${err.message}`);
        const payload = normalizeQueuePayload(message.body) || {};
        await recordAdminError(env, {
          where: "queue",
          message: err.message,
          chatId: payload.chatId,
          detail: payload.artistName || null,
        });
        message.retry();
      }
    }
  },
};

export default worker;

export { HELP_TEXT } from "./messages/fa.js";
export {
  ARTIST_DELIVERY_DLQ_NAME,
  ARTIST_DELIVERY_QUEUE_NAME,
  getArtistQueueDelaySeconds,
  getMaxAudioUrlAttempts,
  isAdminUser,
} from "./config.js";
export { TelegramRateLimitError, callTelegram } from "./telegram/api.js";
export { sendTrackToUser } from "./telegram/send.js";
export {
  artistNamesEqual,
  buildFallbackUrls,
  extractArtistName,
  extractLinkFromMessage,
  getMp3QualityRank,
  hostnameOf,
  normalizeArtistName,
  normalizeInput,
  orderSongUrls,
  parseMediaFromUrl,
  resolveSongUrls,
} from "./rj/urls.js";
export {
  extractTracksFromPayload,
  extractPlaylistsFromPayload,
  fetchArtistCatalog,
  fetchPlaylistTracks,
  fetchAlbumTracks,
  selectArtistTracks,
  sortTracksByNewest,
} from "./rj/tracks.js";
export {
  cacheTelegramFile,
  deleteCachedTelegramFile,
  filterUncachedTracks,
  getCachedTelegramFile,
  getTelegramFileCacheKey,
  isTrackCached,
  normalizeCachePermlink,
} from "./cache/telegram-file.js";
export {
  cancelChatArtistDelivery,
  parseBotCommand,
} from "./bot/commands.js";
export { handleSearchQuery, searchRadioJavan } from "./bot/search.js";
export { handleInlineQuery } from "./bot/inline.js";
export { processUpdate, handleStartPayload } from "./bot/update.js";
export { handleUrl } from "./bot/handle-url.js";
export { presentArtistMenu, startArtistDelivery } from "./bot/artist-menu.js";
export { makeStartPayload, resolveStartPayload } from "./bot/start-payload.js";
export { handleHealth } from "./routes/http.js";
export {
  compactQueuedTrack,
  createQueuedArtistPayload,
  enqueueArtistQueueDelivery,
  runQueuedArtistMessage,
} from "./delivery/queue.js";
export { handleArtistDeliveryDlq } from "./delivery/dlq.js";
export { warmArtistMissingTracks } from "./delivery/warm.js";
export { buildAudioMeta } from "./telegram/send.js";

