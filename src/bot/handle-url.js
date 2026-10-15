import { getBotToken, KvWriteLimitError } from "../config.js";
import { extractArtistName, parseMediaFromUrl, resolveRedirect } from "../rj/urls.js";
import {
  fetchAlbumTracks,
  fetchPlaylistTracks,
  isSupportedMediaType,
  resolveDownloadUrls,
} from "../rj/tracks.js";
import { sendMessage, sendTrackToUser } from "../telegram/send.js";
import { presentArtistMenu, enqueueBulkDelivery } from "./artist-menu.js";
import { incrementStat } from "../admin/stats.js";
import { checkAndConsumeQuota, recordUserActivity } from "../admin/users.js";

async function ensureQuota(env, chatId, amount, token) {
  const quota = await checkAndConsumeQuota(env, chatId, amount);
  if (quota.ok) {
    return true;
  }
  await recordUserActivity(env, chatId, {
    type: "quota_blocked",
    detail: `${quota.used}/${quota.limit}`,
  });
  await sendMessage(
    chatId,
    `سهمیهٔ دانلود روزانه تمام شده است (${quota.used}/${quota.limit}). فردا دوباره تلاش کنید یا با ادمین تماس بگیرید.`,
    token
  );
  return false;
}

async function handleUrl(userId, url, env, origin) {
  try {
    if (url.startsWith("https://rj.app/")) {
      url = await resolveRedirect(url);
      console.log(`Redirected to: ${url}`);
    }

    const { mediaType, mediaName } = parseMediaFromUrl(url);

    if (mediaType === "artist") {
      const artistName = extractArtistName(url);
      await presentArtistMenu(userId, artistName, env);
      return;
    }

    if (mediaType === "playlist") {
      await sendMessage(userId, `در حال دریافت پلی‌لیست...`, getBotToken(env));
      let tracks;
      try {
        tracks = await fetchPlaylistTracks(env, mediaName);
      } catch (err) {
        console.error(`Error fetching playlist: ${err.message}`);
        await sendMessage(userId, `❌ خطا در دریافت پلی‌لیست: ${err.message}`, getBotToken(env));
        return;
      }
      await incrementStat(env, "playlists");
      await enqueueBulkDelivery(env, userId, `پلی‌لیست ${mediaName}`, tracks);
      return;
    }

    if (mediaType === "album") {
      await sendMessage(userId, `در حال دریافت آلبوم...`, getBotToken(env));
      let album;
      try {
        album = await fetchAlbumTracks(env, mediaName);
      } catch (err) {
        console.error(`Error fetching album: ${err.message}`);
        await sendMessage(userId, `❌ خطا در دریافت آلبوم: ${err.message}`, getBotToken(env));
        return;
      }
      const label = album.artist ? `${album.artist} - ${album.title}` : album.title;
      await incrementStat(env, "albums");
      await enqueueBulkDelivery(env, userId, label, album.tracks);
      return;
    }

    if (mediaType === "video" || mediaType === "podcast") {
      await sendMessage(userId, "فقط لینک آهنگ، آلبوم، پلی‌لیست یا خواننده پشتیبانی می‌شود.", getBotToken(env));
      return;
    }

    if (!isSupportedMediaType(mediaType)) {
      await sendMessage(userId, "این نوع رسانه پشتیبانی نمی‌شود!", getBotToken(env));
      return;
    }

    const { urls, title, artist, duration, photo } = await resolveDownloadUrls(env, mediaType, mediaName);
    if (!urls.length) {
      await sendMessage(userId, "این نوع رسانه پشتیبانی نمی‌شود!", getBotToken(env));
      return;
    }

    const track = {
      permlink: mediaName,
      title,
      artist,
      duration,
      photo,
      mediaType,
      urls,
    };

    if (!(await ensureQuota(env, userId, 1, getBotToken(env)))) {
      return;
    }

    try {
      await sendTrackToUser(userId, track, env, { preferUrl: true, cacheUploads: true });
      await incrementStat(env, "songs");
      await recordUserActivity(env, userId, {
        type: "download_song",
        detail: track.permlink || title || mediaName,
      });
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
