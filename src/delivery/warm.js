import { getBotToken } from "../config.js";
import { normalizeArtistName } from "../rj/urls.js";
import { fetchArtistTracks } from "../rj/tracks.js";
import { filterUncachedTracks } from "../cache/telegram-file.js";
import { sendMessage } from "../telegram/send.js";
import { enqueueArtistQueueDelivery } from "./queue.js";

async function warmArtistMissingTracks(env, chatId, artistName) {
  const token = getBotToken(env);
  artistName = normalizeArtistName(artistName);
  try {
    const tracks = await fetchArtistTracks(env, artistName);
    if (!tracks.length) {
      await sendMessage(chatId, `آهنگی برای ${artistName} پیدا نشد.`, token);
      return { artistName, total: 0, missing: 0, queued: 0 };
    }

    const missing = await filterUncachedTracks(env, tracks);
    if (!missing.length) {
      await sendMessage(
        chatId,
        `همهٔ ${tracks.length} آهنگ ${artistName} از قبل در کش هستند. چیزی برای گرم‌کردن نیست.`,
        token
      );
      return { artistName, total: tracks.length, missing: 0, queued: 0 };
    }

    await enqueueArtistQueueDelivery(env, chatId, artistName, missing, {
      warmCache: true,
      originalTotal: tracks.length,
    });
    console.log(
      `Warm artist ${artistName}: queueing ${missing.length}/${tracks.length} uncached tracks for chat ${chatId}`
    );
    return {
      artistName,
      total: tracks.length,
      missing: missing.length,
      queued: missing.length,
    };
  } catch (err) {
    console.error(`Warm artist ${artistName} failed: ${err.message}`);
    await sendMessage(chatId, `گرم‌کردن کش برای ${artistName} ناموفق بود: ${err.message}`, token);
    throw err;
  }
}

export { warmArtistMissingTracks };
