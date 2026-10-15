import { ARTIST_LATEST_OPTIONS, getBotToken } from "../config.js";
import { normalizeArtistName } from "../rj/urls.js";
import { fetchArtistCatalog, selectArtistTracks } from "../rj/tracks.js";
import { sendMessage } from "../telegram/send.js";
import { makeCallbackData } from "./callback-store.js";
import { enqueueArtistQueueDelivery } from "../delivery/queue.js";
import { incrementStat } from "../admin/stats.js";
import { checkAndConsumeQuota } from "../admin/users.js";

async function buildArtistChoiceKeyboard(env, artistName, catalog) {
  const rows = [];
  const total = catalog.tracks.length;
  const options = catalog.latestOptions || ARTIST_LATEST_OPTIONS;

  for (const limit of options) {
    if (total > limit) {
      rows.push([
        {
          text: `🆕 آخرین ${limit} آهنگ`.slice(0, 64),
          callback_data: await makeCallbackData(env, "n", `${artistName}|${limit}`),
        },
      ]);
    }
  }

  if (total > 0) {
    rows.push([
      {
        text: `🎶 همهٔ آهنگ‌ها (${total})`.slice(0, 64),
        callback_data: await makeCallbackData(env, "A", artistName),
      },
    ]);
  }

  for (const playlist of catalog.playlists || []) {
    const countLabel = playlist.count ? ` (${playlist.count})` : "";
    rows.push([
      {
        text: `📋 ${playlist.title}${countLabel}`.slice(0, 64),
        callback_data: await makeCallbackData(env, "p", playlist.id),
      },
    ]);
  }

  return { inline_keyboard: rows };
}

async function presentArtistMenu(chatId, artistName, env) {
  const token = getBotToken(env);
  artistName = normalizeArtistName(artistName);
  await sendMessage(chatId, `در حال دریافت گزینه‌های ${artistName}...`, token);

  let catalog;
  try {
    catalog = await fetchArtistCatalog(env, artistName);
  } catch (err) {
    console.error(`Error fetching artist catalog: ${err.message}`);
    await sendMessage(chatId, `❌ خطا در دریافت آهنگ‌های خواننده: ${err.message}`, token);
    return;
  }

  if (!catalog.tracks.length && !(catalog.playlists || []).length) {
    await sendMessage(chatId, `برای ${artistName} آهنگ یا پلی‌لیستی پیدا نشد.`, token);
    return;
  }

  // Small catalogs: skip chooser and send everything.
  if (
    catalog.tracks.length > 0 &&
    catalog.tracks.length <= Math.min(...ARTIST_LATEST_OPTIONS) &&
    !(catalog.playlists || []).length
  ) {
    await enqueueBulkDelivery(env, chatId, artistName, catalog.tracks);
    return;
  }

  const keyboard = await buildArtistChoiceKeyboard(env, artistName, catalog);
  const lines = [
    `خواننده: ${artistName}`,
    catalog.tracks.length ? `${catalog.tracks.length} آهنگ پیدا شد.` : "آهنگی در کاتالوگ پیدا نشد.",
    (catalog.playlists || []).length
      ? `${catalog.playlists.length} پلی‌لیست مرتبط — یکی را انتخاب کنید:`
      : "یکی از گزینه‌ها را انتخاب کنید:",
  ];
  await sendMessage(chatId, lines.join("\n"), token, { reply_markup: keyboard });
}

async function enqueueBulkDelivery(env, chatId, label, tracks, { skipQuota = false } = {}) {
  const token = getBotToken(env);
  if (!env.ARTIST_QUEUE) {
    await sendMessage(
      chatId,
      "صف ارسال پیکربندی نشده است. لطفاً بعداً دوباره تلاش کنید.",
      token
    );
    return;
  }
  if (!tracks?.length) {
    await sendMessage(chatId, "آهنگی برای ارسال پیدا نشد.", token);
    return;
  }
  let deliveryTracks = tracks;
  if (!skipQuota) {
    const quota = await checkAndConsumeQuota(env, chatId, deliveryTracks.length);
    if (!quota.ok) {
      if (quota.remaining > 0) {
        deliveryTracks = deliveryTracks.slice(0, quota.remaining);
        await checkAndConsumeQuota(env, chatId, deliveryTracks.length);
        await sendMessage(
          chatId,
          `سهمیهٔ امروز محدود است؛ فقط ${deliveryTracks.length} آهنگ ارسال می‌شود (${quota.used}/${quota.limit}).`,
          token
        );
      } else {
        await sendMessage(
          chatId,
          `سهمیهٔ دانلود روزانه تمام شده است (${quota.used}/${quota.limit}). فردا دوباره تلاش کنید.`,
          token
        );
        return;
      }
    }
  }
  try {
    await enqueueArtistQueueDelivery(env, chatId, label, deliveryTracks);
  } catch (err) {
    console.error(`Queue delivery failed for ${label}: ${err.message}`);
    await sendMessage(chatId, `❌ خطا در صف ارسال: ${err.message}`, token);
  }
}

async function startArtistDelivery(chatId, artistName, env, { limit = null } = {}) {
  const token = getBotToken(env);
  artistName = normalizeArtistName(artistName);
  await sendMessage(
    chatId,
    limit
      ? `در حال آماده‌سازی آخرین ${limit} آهنگ ${artistName}...`
      : `در حال آماده‌سازی همهٔ آهنگ‌های ${artistName}...`,
    token
  );

  let catalog;
  try {
    catalog = await fetchArtistCatalog(env, artistName);
  } catch (err) {
    await sendMessage(chatId, `❌ خطا در دریافت آهنگ‌های خواننده: ${err.message}`, token);
    return;
  }

  const tracks = selectArtistTracks(catalog.tracks, limit);
  const label = limit ? `${artistName} (آخرین ${tracks.length})` : artistName;
  await incrementStat(env, "artists");
  await enqueueBulkDelivery(env, chatId, label, tracks);
}

export {
  buildArtistChoiceKeyboard,
  presentArtistMenu,
  enqueueBulkDelivery,
  startArtistDelivery,
};
