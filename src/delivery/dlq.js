import { getBotToken, getArtistQueueDelaySeconds } from "../config.js";
import { sendMessage } from "../telegram/send.js";
import { recordDlqEvent } from "../admin/dlq-log.js";
import {
  enqueueArtistQueueMessage,
  finishQueueChatDelivery,
  normalizeQueuePayload,
} from "./queue.js";

async function handleArtistDeliveryDlq(env, body) {
  const payload = normalizeQueuePayload(body);
  const token = getBotToken(env);
  const nextSong = Math.min((payload.nextIndex || 0) + 1, payload.total || 0);
  const progress = `در آهنگ ${nextSong}/${payload.total || 0} متوقف شد (ارسال‌شده: ${payload.sent || 0}).`;
  const retryCount = Number(payload.dlqRetryCount || 0);
  console.error(
    `Artist delivery DLQ for ${payload.artistName} chat ${payload.chatId}: ${progress} retry=${retryCount}`
  );

  // Auto-retry once from DLQ, then give up and notify.
  if (retryCount < 1 && payload.chatId && Array.isArray(payload.tracks) && payload.nextIndex < payload.total) {
    payload.dlqRetryCount = retryCount + 1;
    payload.rateLimitBoost = Math.min((payload.rateLimitBoost || 0) + 5, 30);
    try {
      const delaySeconds = Math.max(getArtistQueueDelaySeconds(env) + (payload.rateLimitBoost || 0), 5);
      await enqueueArtistQueueMessage(env, payload, { delaySeconds });
      await recordDlqEvent(env, payload, { retryCount, autoRetried: true });
      await sendMessage(
        payload.chatId,
        `ارسال ${payload.artistName} به صف خطا رفت. یک‌بار دیگر از آهنگ ${nextSong}/${payload.total} تلاش می‌شود...`,
        token
      );
      console.log(`DLQ auto-retry queued for ${payload.artistName} chat ${payload.chatId}`);
      return;
    } catch (err) {
      console.warn(`DLQ auto-retry enqueue failed: ${err.message}`);
    }
  }

  await recordDlqEvent(env, payload, { retryCount, autoRetried: false });

  try {
    await sendMessage(
      payload.chatId,
      `ارسال ${payload.artistName} بعد از چند خطای پیاپی متوقف شد. ${progress} دوباره لینک خواننده را بفرستید یا /search ${payload.artistName}.`,
      token
    );
  } catch (err) {
    console.warn(`Failed to notify chat about artist DLQ: ${err.message}`);
  }

  await finishQueueChatDelivery(env, payload);
}

export { handleArtistDeliveryDlq };
