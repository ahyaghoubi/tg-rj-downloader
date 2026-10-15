import {
  QUEUE_CHAT_ACTIVE_TTL_S,
  getBotToken,
  getArtistQueueDelaySeconds,
  getArtistProgressEvery,
  getJobStore,
  putKv,
  KvWriteLimitError,
  queueChatActiveKey,
  queueChatPendingKey,
  queueChatCancelKey,
} from "../config.js";
import { artistNamesEqual, normalizeArtistName } from "../rj/urls.js";
import { sendMessage, sendTrackToUser } from "../telegram/send.js";
import { TelegramRateLimitError } from "../telegram/api.js";
import { incrementStat } from "../admin/stats.js";

function getArtistJobTrackKey(track) {
  return `${track.mediaType || "song"}:${String(track.permlink || track.title || "").toLowerCase()}`;
}

function compactQueuedTrack(track) {
  const compact = {
    permlink: track.permlink,
    title: track.title || track.permlink,
    mediaType: track.mediaType || "song",
  };
  if (track.artist) {
    compact.artist = String(track.artist).slice(0, 64);
  }
  if (Number.isFinite(Number(track.duration)) && Number(track.duration) > 0) {
    compact.duration = Math.round(Number(track.duration));
  }
  return compact;
}

function createQueuedArtistPayload(chatId, artistName, tracks, options = {}) {
  const payload = {
    chatId,
    artistName: normalizeArtistName(artistName),
    tracks: tracks.map(compactQueuedTrack),
    total: tracks.length,
    nextIndex: 0,
    sent: 0,
    failed: [],
    sentTrackKeys: [],
    createdAt: new Date().toISOString(),
  };
  if (options.warmCache) {
    payload.warmCache = true;
  }
  if (Number.isFinite(options.originalTotal) && options.originalTotal > 0) {
    payload.originalTotal = options.originalTotal;
  }
  return payload;
}

function normalizeQueuePayload(body) {
  const payload = typeof body === "string" ? JSON.parse(body) : body;
  if (payload?.artistName) {
    payload.artistName = normalizeArtistName(payload.artistName);
  }
  return payload;
}

async function enqueueArtistQueueMessage(env, payload, options = {}) {
  if (!env.ARTIST_QUEUE) {
    throw new Error("ARTIST_QUEUE binding is not configured");
  }
  await env.ARTIST_QUEUE.send(payload, options);
}

async function enqueueArtistQueueDelivery(env, chatId, artistName, tracks, options = {}) {
  const token = getBotToken(env);
  artistName = normalizeArtistName(artistName);
  const payload = createQueuedArtistPayload(chatId, artistName, tracks, options);
  const kv = getJobStore(env);
  const label = payload.warmCache ? "گرم‌کردن کش" : "ارسال";

  if (kv) {
    const activeRaw = await kv.get(queueChatActiveKey(chatId));
    if (activeRaw) {
      let activeArtist = null;
      try {
        activeArtist = normalizeArtistName(JSON.parse(activeRaw)?.artistName || "") || null;
      } catch (_) {
        // ignore
      }

      if (activeArtist && artistNamesEqual(activeArtist, artistName)) {
        await sendMessage(
          chatId,
          `ارسال ${artistName} همین حالا در حال انجام است و ادامه پیدا می‌کند. برای توقف /cancel را بفرستید.`,
          token
        );
        return payload;
      }

      let activeTotal = null;
      try {
        activeTotal = Number(JSON.parse(activeRaw)?.total) || null;
      } catch (_) {
        // ignore
      }

      await putKv(kv, queueChatPendingKey(chatId), JSON.stringify(payload));
      const activeLabel = activeArtist
        ? activeTotal
          ? `${activeArtist} — ${activeTotal} آهنگ`
          : activeArtist
        : "ارسال فعلی";
      await sendMessage(
        chatId,
        [
          `موقعیت صف برای این چت:`,
          `۱) در حال ارسال: ${activeLabel}`,
          `۲) در انتظار: ${label} «${artistName}» (${tracks.length} آهنگ)`,
          ``,
          `بعد از اتمام مورد ۱، مورد ۲ خودکار شروع می‌شود.`,
          `برای توقف مورد فعلی /cancel را بفرستید.`,
        ].join("\n"),
        token
      );
      return payload;
    }

    try {
      await putKv(
        kv,
        queueChatActiveKey(chatId),
        JSON.stringify({
          artistName,
          total: tracks.length,
          warmCache: Boolean(payload.warmCache),
          startedAt: new Date().toISOString(),
        }),
        { expirationTtl: QUEUE_CHAT_ACTIVE_TTL_S }
      );
    } catch (err) {
      if (!(err instanceof KvWriteLimitError)) {
        throw err;
      }
      console.warn(`Skipping queue chat lock write: ${err.message}`);
    }
  }

  await enqueueArtistQueueMessage(env, payload);
  if (payload.warmCache) {
    await sendMessage(
      chatId,
      `در حال گرم‌کردن کش برای ${artistName}: ${tracks.length} آهنگ بدون کش` +
        (payload.originalTotal ? ` از ${payload.originalTotal}` : "") +
        `. آهنگ‌های قبلاً کش‌شده رد می‌شوند.`,
      token
    );
  } else {
    await sendMessage(chatId, `${tracks.length} آهنگ برای ${artistName} پیدا شد. در حال ارسال...`, token);
  }
  return payload;
}

async function promotePendingQueueChatDelivery(env, chatId) {
  const kv = getJobStore(env);
  if (!kv) {
    return;
  }

  const pendingKey = queueChatPendingKey(chatId);
  const pendingRaw = await kv.get(pendingKey);
  if (!pendingRaw) {
    return;
  }

  try {
    await kv.delete(pendingKey);
  } catch (err) {
    console.warn(`Failed to clear pending queue delivery for ${chatId}: ${err.message}`);
  }

  let pending;
  try {
    pending = JSON.parse(pendingRaw);
  } catch (err) {
    console.warn(`Invalid pending queue payload for ${chatId}: ${err.message}`);
    return;
  }

  if (!pending?.artistName || !Array.isArray(pending.tracks)) {
    return;
  }

  try {
    await putKv(
      kv,
      queueChatActiveKey(chatId),
      JSON.stringify({
        artistName: pending.artistName,
        total: pending.total || pending.tracks.length,
        startedAt: new Date().toISOString(),
      }),
      { expirationTtl: QUEUE_CHAT_ACTIVE_TTL_S }
    );
  } catch (err) {
    if (!(err instanceof KvWriteLimitError)) {
      throw err;
    }
    console.warn(`Skipping queue chat lock write while promoting: ${err.message}`);
  }

  await enqueueArtistQueueMessage(env, pending);
  await sendMessage(
    chatId,
    `شروع ارسال صف‌شده برای ${pending.artistName} (${pending.total || pending.tracks.length} آهنگ)...`,
    getBotToken(env)
  );
}

async function finishQueueChatDelivery(env, payload) {
  const kv = getJobStore(env);
  if (!kv || !payload?.chatId) {
    return;
  }

  const activeKey = queueChatActiveKey(payload.chatId);
  try {
    const activeRaw = await kv.get(activeKey);
    if (activeRaw) {
      let shouldClear = true;
      try {
        const active = JSON.parse(activeRaw);
        if (
          active?.artistName &&
          payload.artistName &&
          !artistNamesEqual(active.artistName, payload.artistName)
        ) {
          shouldClear = false;
        }
      } catch (_) {
        // Clear unreadable lock records.
      }
      if (shouldClear) {
        await kv.delete(activeKey);
      }
    }
  } catch (err) {
    console.warn(`Failed to clear queue chat lock for ${payload.chatId}: ${err.message}`);
  }

  await promotePendingQueueChatDelivery(env, payload.chatId);
}

async function isChatDeliveryCancelled(env, chatId, payloadCreatedAt = null) {
  const kv = getJobStore(env);
  if (!kv || !chatId) {
    return false;
  }
  try {
    const raw = await kv.get(queueChatCancelKey(chatId));
    if (!raw) {
      return false;
    }
    let cancelledAtMs = NaN;
    try {
      const parsed = JSON.parse(raw);
      cancelledAtMs = Date.parse(parsed?.cancelledAt || "");
    } catch {
      // Legacy cancel flags were plain "1".
      cancelledAtMs = Date.now();
    }
    if (!Number.isFinite(cancelledAtMs)) {
      return true;
    }
    if (!payloadCreatedAt) {
      return true;
    }
    const createdAtMs = Date.parse(payloadCreatedAt);
    if (!Number.isFinite(createdAtMs)) {
      return true;
    }
    return createdAtMs <= cancelledAtMs;
  } catch {
    return false;
  }
}

async function runQueuedArtistMessage(env, body) {
  const payload = normalizeQueuePayload(body);
  const token = getBotToken(env);
  payload.sentTrackKeys ||= [];
  payload.failed ||= [];

  if (await isChatDeliveryCancelled(env, payload.chatId, payload.createdAt)) {
    // Timestamp latch: only payloads created at/before cancel time are stopped.
    console.log(`Queue artist delivery ${payload.artistName}: cancelled by user`);
    try {
      const kv = getJobStore(env);
      if (kv) {
        await kv.delete(queueChatActiveKey(payload.chatId));
      }
    } catch (_) {
      // best effort
    }
    return;
  }

  console.log(
    `Queue artist delivery ${payload.artistName}: starting index ${payload.nextIndex + 1}/${payload.total}`
  );

  while (payload.nextIndex < payload.total) {
    const track = payload.tracks[payload.nextIndex];
    const trackKey = getArtistJobTrackKey(track);

    if (payload.sentTrackKeys.includes(trackKey)) {
      payload.nextIndex += 1;
      continue;
    }

    try {
      await sendTrackToUser(payload.chatId, track, env, {
        preferUrl: true,
        // Warm jobs always write cache; normal artist delivery keeps free-tier bulk writes off.
        // Artist deliveries only read TELEGRAM_FILE_CACHE; writes happen for warm jobs / single songs.
        cacheUploads: Boolean(payload.warmCache),
      });
      payload.sentTrackKeys.push(trackKey);
      payload.sent += 1;
      payload.nextIndex += 1;
      if (!payload.warmCache) {
        await incrementStat(env, "songs");
      }
      console.log(
        `Queue artist delivery ${payload.artistName}: sent ${payload.sent}/${payload.total}`
      );

      const every = getArtistProgressEvery(env);
      if (every > 0 && payload.sent % every === 0 && payload.nextIndex < payload.total) {
        await sendMessage(
          payload.chatId,
          `پیشرفت: ${payload.sent}/${payload.total} آهنگ از ${payload.artistName} ارسال شد...`,
          token
        );
      }
    } catch (err) {
      if (err instanceof TelegramRateLimitError) {
        throw err;
      }

      payload.failed.push(track.title || track.permlink);
      payload.nextIndex += 1;
      console.warn(`Queue artist delivery failed for ${track.permlink}: ${err.message}`);
    }

    break;
  }

  if (payload.nextIndex >= payload.total) {
    let summary = payload.warmCache
      ? `گرم‌کردن کش ${payload.artistName} تمام شد. ${payload.sent}/${payload.total} آهنگِ قبلیِ بدون کش ارسال/کش شد` +
        (payload.originalTotal ? ` (از ${payload.originalTotal} آهنگ کل)` : "") +
        `.`
      : `ارسال ${payload.artistName} تمام شد. ${payload.sent}/${payload.total} آهنگ ارسال شد.`;
    if (payload.failed.length) {
      summary += `\n\nارسال نشد:\n${payload.failed.join("\n")}`;
    }
    await sendMessage(payload.chatId, summary, token);
    console.log(`Queue artist delivery ${payload.artistName}: completed`);
    await finishQueueChatDelivery(env, payload);
    return;
  }

  const delaySeconds = Math.max(
    getArtistQueueDelaySeconds(env) + Number(payload.rateLimitBoost || 0),
    getArtistQueueDelaySeconds(env)
  );
  await enqueueArtistQueueMessage(env, payload, { delaySeconds });
  console.log(
    `Queue artist delivery ${payload.artistName}: enqueued index ${
      payload.nextIndex + 1
    }/${payload.total} after ${delaySeconds}s`
  );
}

export {
  getArtistJobTrackKey,
  compactQueuedTrack,
  createQueuedArtistPayload,
  normalizeQueuePayload,
  enqueueArtistQueueMessage,
  enqueueArtistQueueDelivery,
  promotePendingQueueChatDelivery,
  finishQueueChatDelivery,
  isChatDeliveryCancelled,
  runQueuedArtistMessage,
};
