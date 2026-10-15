import {
  ARTIST_DELIVERY_QUEUE_NAME,
  ARTIST_DELIVERY_DLQ_NAME,
  MAX_RECENT_ITEMS,
  getBotToken,
  getJobStore,
  putKv,
  isAdminUser,
  getAdminUserIds,
  getArtistQueueDelaySeconds,
  getArtistProgressEvery,
  shouldCacheArtistUploads,
  queueChatActiveKey,
  queueChatPendingKey,
  queueChatCancelKey,
  userRecentKey,
  KvWriteLimitError,
} from "../config.js";
import { normalizeArtistName } from "../rj/urls.js";
import { sendMessage } from "../telegram/send.js";
import { makeCallbackData } from "./callback-store.js";

function parseBotCommand(text) {
  if (!text || !text.startsWith("/")) {
    return null;
  }
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].slice(1).toLowerCase();
  return { name: cmd, arg: rest.join(" ").trim() };
}

async function readUserRecents(env, chatId) {
  const kv = getJobStore(env);
  if (!kv) {
    return [];
  }
  try {
    const raw = await kv.get(userRecentKey(chatId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function pushUserRecent(env, chatId, item) {
  const kv = getJobStore(env);
  if (!kv || !chatId || !item) {
    return;
  }
  try {
    const existing = await readUserRecents(env, chatId);
    const key = `${item.type}:${String(item.value || "").toLowerCase()}`;
    const next = [
      { ...item, at: new Date().toISOString() },
      ...existing.filter((entry) => `${entry.type}:${String(entry.value || "").toLowerCase()}` !== key),
    ].slice(0, MAX_RECENT_ITEMS);
    await putKv(kv, userRecentKey(chatId), JSON.stringify(next), { expirationTtl: 30 * 24 * 60 * 60 });
  } catch (err) {
    if (!(err instanceof KvWriteLimitError)) {
      console.warn(`Failed to store recent item for ${chatId}: ${err.message}`);
    }
  }
}

async function cancelChatArtistDelivery(env, chatId) {
  const kv = getJobStore(env);
  const token = getBotToken(env);
  if (!kv) {
    await sendMessage(chatId, "بدون ARTIST_JOB_STORE امکان لغو وجود ندارد.", token);
    return { cancelled: false };
  }

  let activeArtist = null;
  try {
    const activeRaw = await kv.get(queueChatActiveKey(chatId));
    if (activeRaw) {
      activeArtist = normalizeArtistName(JSON.parse(activeRaw)?.artistName || "") || null;
    }
  } catch (_) {
    // ignore
  }

  try {
    await putKv(
      kv,
      queueChatCancelKey(chatId),
      JSON.stringify({ cancelledAt: new Date().toISOString() }),
      { expirationTtl: 60 * 60 }
    );
    await kv.delete(queueChatActiveKey(chatId));
    await kv.delete(queueChatPendingKey(chatId));
  } catch (err) {
    console.warn(`Cancel cleanup failed for ${chatId}: ${err.message}`);
  }

  await sendMessage(
    chatId,
    activeArtist
      ? `لغو ${activeArtist} ثبت شد. ارسال به‌زودی متوقف می‌شود.`
      : "ارسال فعالِ خواننده‌ای برای این چت پیدا نشد. اگر هنوز آهنگ می‌آید، کمی صبر کنید و دوباره /cancel بفرستید.",
    token
  );
  return { cancelled: true, activeArtist };
}

async function handleRecentCommand(chatId, env) {
  const token = getBotToken(env);
  const recents = await readUserRecents(env, chatId);
  if (!recents.length) {
    await sendMessage(chatId, "هنوز جستجو یا دانلودی ثبت نشده است.", token);
    return;
  }

  const rows = [];
  const lines = ["فعالیت‌های اخیر:"];
  for (const item of recents) {
    if (item.type === "search") {
      lines.push(`• جستجو: ${item.label || item.value}`);
      rows.push([
        {
          text: `🔎 ${item.label || item.value}`.slice(0, 64),
          callback_data: await makeCallbackData(env, "q", item.value),
        },
      ]);
    } else if (item.type === "artist") {
      lines.push(`• خواننده: ${item.label || item.value}`);
      rows.push([
        {
          text: `🎤 ${item.label || item.value}`.slice(0, 64),
          callback_data: await makeCallbackData(env, "a", item.value),
        },
      ]);
    } else if (item.type === "song") {
      lines.push(`• آهنگ: ${item.label || item.value}`);
      rows.push([
        {
          text: `🎵 ${item.label || item.value}`.slice(0, 64),
          callback_data: await makeCallbackData(env, "s", item.value),
        },
      ]);
    } else if (item.type === "playlist") {
      lines.push(`• پلی‌لیست: ${item.label || item.value}`);
      rows.push([
        {
          text: `📋 ${item.label || item.value}`.slice(0, 64),
          callback_data: await makeCallbackData(env, "p", item.value),
        },
      ]);
    } else if (item.type === "album") {
      lines.push(`• آلبوم: ${item.label || item.value}`);
      rows.push([
        {
          text: `💿 ${item.label || item.value}`.slice(0, 64),
          callback_data: await makeCallbackData(env, "b", item.value),
        },
      ]);
    }
  }

  await sendMessage(chatId, lines.join("\n"), token, {
    reply_markup: { inline_keyboard: rows },
  });
}

async function handleStatusCommand(chatId, userId, env) {
  const token = getBotToken(env);
  if (!isAdminUser(env, userId)) {
    await sendMessage(chatId, "/status فقط برای ادمین است.", token);
    return;
  }

  const kv = getJobStore(env);
  let active = null;
  let pending = null;
  let cancel = false;
  if (kv) {
    try {
      const activeRaw = await kv.get(queueChatActiveKey(chatId));
      const pendingRaw = await kv.get(queueChatPendingKey(chatId));
      cancel = Boolean(await kv.get(queueChatCancelKey(chatId)));
      active = activeRaw ? JSON.parse(activeRaw) : null;
      pending = pendingRaw ? JSON.parse(pendingRaw) : null;
    } catch (err) {
      console.warn(`Status read failed: ${err.message}`);
    }
  }

  const lines = [
    "وضعیت ادمین",
    `صف ربات: ${ARTIST_DELIVERY_QUEUE_NAME}`,
    `صف خطا (dlq): ${ARTIST_DELIVERY_DLQ_NAME}`,
    `نوشتن انبوه کش: ${shouldCacheArtistUploads(env)}`,
    `تأخیر صف: ${getArtistQueueDelaySeconds(env)}ث`,
    `بازهٔ پیشرفت: ${getArtistProgressEvery(env)}`,
    `فعال: ${active ? `${normalizeArtistName(active.artistName)} (${active.total || "?"})` : "هیچ"}`,
    `در انتظار: ${pending ? `${normalizeArtistName(pending.artistName)} (${pending.total || pending.tracks?.length || "?"})` : "هیچ"}`,
    `پرچم لغو: ${cancel ? "بله" : "خیر"}`,
    `ادمین‌ها: ${getAdminUserIds(env).join(", ") || "(هیچ)"}`,
  ];
  await sendMessage(chatId, lines.join("\n"), token, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔄 بروزرسانی", callback_data: "st:refresh" },
          { text: "⏹ لغو فعال", callback_data: "st:cancel" },
        ],
        [{ text: "🧹 پاک کردن pending", callback_data: "st:clear" }],
      ],
    },
  });
}

export {
  parseBotCommand,
  readUserRecents,
  pushUserRecent,
  cancelChatArtistDelivery,
  handleRecentCommand,
  handleStatusCommand,
};
