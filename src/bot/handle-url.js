import { getBotToken, KvWriteLimitError } from "../config.js";
import { extractArtistName, parseMediaFromUrl, resolveRedirect } from "../rj/urls.js";
import { fetchArtistTracks, isSupportedMediaType, resolveDownloadUrls } from "../rj/tracks.js";
import { sendMessage, sendTrackToUser } from "../telegram/send.js";
import { enqueueArtistQueueDelivery } from "../delivery/queue.js";

async function handleUrl(userId, url, env, origin) {
  try {
    if (url.startsWith("https://rj.app/")) {
      url = await resolveRedirect(url);
      console.log(`Redirected to: ${url}`);
    }

    const { mediaType, mediaName } = parseMediaFromUrl(url);

    if (mediaType === "artist") {
      const artistName = extractArtistName(url);
      await sendMessage(userId, `در حال دریافت آهنگ‌های ${artistName}...`, getBotToken(env));

      let tracks;
      try {
        tracks = await fetchArtistTracks(env, artistName);
      } catch (err) {
        console.error(`Error fetching artist songs: ${err.message}`);
        await sendMessage(userId, `❌ خطا در دریافت آهنگ‌های خواننده: ${err.message}`, getBotToken(env));
        return;
      }

      if (!env.ARTIST_QUEUE) {
        await sendMessage(
          userId,
          "صف ارسال خواننده پیکربندی نشده است. لطفاً بعداً دوباره تلاش کنید.",
          getBotToken(env)
        );
        return;
      }

      try {
        await enqueueArtistQueueDelivery(env, userId, artistName, tracks);
      } catch (err) {
        console.error(`Queue artist delivery failed for ${artistName}: ${err.message}`);
        await sendMessage(userId, `❌ خطا در صف ارسال خواننده: ${err.message}`, getBotToken(env));
      }
      return;
    }

    if (mediaType === "video" || mediaType === "podcast") {
      await sendMessage(userId, "فقط لینک آهنگ پشتیبانی می‌شود.", getBotToken(env));
      return;
    }

    if (!isSupportedMediaType(mediaType)) {
      await sendMessage(userId, "این نوع رسانه پشتیبانی نمی‌شود!", getBotToken(env));
      return;
    }

    const { urls, title } = await resolveDownloadUrls(env, mediaType, mediaName);
    if (!urls.length) {
      await sendMessage(userId, "این نوع رسانه پشتیبانی نمی‌شود!", getBotToken(env));
      return;
    }

    const track = {
      permlink: mediaName,
      title,
      mediaType,
      urls,
    };

    try {
      await sendTrackToUser(userId, track, env, { preferUrl: true, cacheUploads: true });
    } catch (err) {
      console.error(`Error sending media: ${err.message}`);
      await sendMessage(
        userId,
        `فایل به تلگرام آپلود نشد. از اینجا دانلود کنید: ${urls[0]}`,
        getBotToken(env)
      );
    }
  } catch (err) {
    console.error(`Error in handleUrl: ${err.message}`);
    if (err instanceof KvWriteLimitError) {
      await sendMessage(
        userId,
        "سهمیهٔ نوشتن KV کلادفلر پر شده است. بعد از ریست سهمیهٔ روزانه دوباره تلاش کنید.",
        getBotToken(env)
      );
      return;
    }
    await sendMessage(
      userId,
      `فایل پردازش نشد. از اینجا دانلود کنید: ${url}`,
      getBotToken(env)
    );
  }
}

export { handleUrl };
