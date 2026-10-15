import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  ARTIST_DELIVERY_DLQ_NAME,
  TelegramRateLimitError,
  compactQueuedTrack,
  createQueuedArtistPayload,
  enqueueArtistQueueDelivery,
  getArtistQueueDelaySeconds,
  handleArtistDeliveryDlq,
  runQueuedArtistMessage,
} from "../worker.js";
import {
  createEnv,
  createQueueBatch,
  mockFetch,
  mockTelegramFetch,
} from "./helpers.js";

test("compactQueuedTrack removes large URL arrays from queue messages", () => {
  const track = {
    permlink: "Ebi-Test",
    title: "Ebi Test",
    mediaType: "song",
    urls: ["https://example.com/very-long-url.mp3"],
    extra: "not needed in queue payload",
  };

  assert.deepEqual(compactQueuedTrack(track), {
    permlink: "Ebi-Test",
    title: "Ebi Test",
    mediaType: "song",
  });
});

test("createQueuedArtistPayload stays compact for large artists", () => {
  const tracks = Array.from({ length: 206 }, (_, index) => ({
    permlink: `Ebi-${index}`,
    title: `Ebi ${index}`,
    mediaType: "song",
    urls: Array.from({ length: 10 }, (__, urlIndex) => `https://cdn.example.com/${index}/${urlIndex}`),
  }));

  const payload = createQueuedArtistPayload("224032101", "ebi", tracks);
  const serialized = JSON.stringify(payload);

  assert.equal(payload.total, 206);
  assert.equal(payload.tracks[0].urls, undefined);
  assert.ok(serialized.length < 128 * 1024);
});

test("runQueuedArtistMessage sends one track and enqueues the next with delay", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv();

  try {
    await runQueuedArtistMessage(env, {
      chatId: "224032101",
      artistName: "ebi",
      tracks: [
        { permlink: "Ebi-One", title: "One", mediaType: "song" },
        { permlink: "Ebi-Two", title: "Two", mediaType: "song" },
      ],
      total: 2,
      nextIndex: 0,
      sent: 0,
      failed: [],
      sentTrackKeys: [],
      createdAt: new Date().toISOString(),
    });

    assert.equal(telegram.calls.length, 1);
    assert.equal(env.queueMessages.length, 1);
    assert.equal(env.queueMessages[0].options.delaySeconds, 2);
    assert.equal(env.queueMessages[0].payload.nextIndex, 1);
    assert.equal(env.queueMessages[0].payload.sent, 1);
  } finally {
    telegram.restore();
  }
});

test("runQueuedArtistMessage completes without enqueueing after final track", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv();

  try {
    await runQueuedArtistMessage(env, {
      chatId: "224032101",
      artistName: "ebi",
      tracks: [{ permlink: "Ebi-One", title: "One", mediaType: "song" }],
      total: 1,
      nextIndex: 0,
      sent: 0,
      failed: [],
      sentTrackKeys: [],
      createdAt: new Date().toISOString(),
    });

    assert.equal(telegram.calls.length, 2);
    assert.equal(env.queueMessages.length, 0);
    assert.match(telegram.calls[1].init.body, /ارسال ebi تمام شد/);
  } finally {
    telegram.restore();
  }
});

test("runQueuedArtistMessage surfaces Telegram retry_after for Queue retry", async () => {
  const telegram = mockTelegramFetch({ ok: false, retryAfter: 17 });
  const env = createEnv();

  try {
    await assert.rejects(
      () =>
        runQueuedArtistMessage(env, {
          chatId: "224032101",
          artistName: "ebi",
          tracks: [{ permlink: "Ebi-One", title: "One", mediaType: "song" }],
          total: 1,
          nextIndex: 0,
          sent: 0,
          failed: [],
          sentTrackKeys: [],
          createdAt: new Date().toISOString(),
        }),
      (err) => err instanceof TelegramRateLimitError && err.retryAfter === 17
    );
  } finally {
    telegram.restore();
  }
});

test("runQueuedArtistMessage skips duplicate track keys and sends next unique track", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv();

  try {
    await runQueuedArtistMessage(env, {
      chatId: "224032101",
      artistName: "ebi",
      tracks: [
        { permlink: "Ebi-One", title: "One", mediaType: "song" },
        { permlink: "Ebi-Two", title: "Two", mediaType: "song" },
      ],
      total: 2,
      nextIndex: 0,
      sent: 1,
      failed: [],
      sentTrackKeys: ["song:ebi-one"],
      createdAt: new Date().toISOString(),
    });

    assert.equal(telegram.calls.length, 2);
    assert.equal(env.queueMessages.length, 0);
    assert.match(telegram.calls[1].init.body, /ارسال ebi تمام شد/);
  } finally {
    telegram.restore();
  }
});

test("runQueuedArtistMessage records failed track and continues to next message", async () => {
  const env = createEnv();
  const telegram = mockFetch(() =>
    new Response(JSON.stringify({ ok: false, description: "Telegram rejected file" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  );

  try {
    await runQueuedArtistMessage(env, {
      chatId: "224032101",
      artistName: "ebi",
      tracks: [
        { permlink: "Ebi-Bad", title: "Bad", mediaType: "song" },
        { permlink: "Ebi-Good", title: "Good", mediaType: "song" },
      ],
      total: 2,
      nextIndex: 0,
      sent: 0,
      failed: [],
      sentTrackKeys: [],
      createdAt: new Date().toISOString(),
    });

    assert.equal(env.queueMessages.length, 1);
    assert.equal(env.queueMessages[0].payload.nextIndex, 1);
    assert.deepEqual(env.queueMessages[0].payload.failed, ["Bad"]);
  } finally {
    telegram.restore();
  }
});

test("Worker queue handler acks successful messages", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv();
  const batch = createQueueBatch([
    {
      chatId: "224032101",
      artistName: "ebi",
      tracks: [{ permlink: "Ebi-One", title: "One", mediaType: "song" }],
      total: 1,
      nextIndex: 0,
      sent: 0,
      failed: [],
      sentTrackKeys: [],
    },
  ]);

  try {
    await worker.queue(batch, env, {});
    assert.equal(batch.messages[0].acked, true);
    assert.equal(batch.messages[0].retried, false);
  } finally {
    telegram.restore();
  }
});

test("Worker queue handler requeues Telegram 429 with boosted delay", async () => {
  const telegram = mockTelegramFetch({ ok: false, retryAfter: 11 });
  const env = createEnv();
  const batch = createQueueBatch([
    {
      chatId: "224032101",
      artistName: "ebi",
      tracks: [{ permlink: "Ebi-One", title: "One", mediaType: "song" }],
      total: 1,
      nextIndex: 0,
      sent: 0,
      failed: [],
      sentTrackKeys: [],
    },
  ]);

  try {
    await worker.queue(batch, env, {});
    assert.equal(batch.messages[0].acked, true);
    assert.equal(batch.messages[0].retried, false);
    assert.equal(env.queueMessages.length, 1);
    assert.equal(env.queueMessages[0].payload.rateLimitBoost >= 2, true);
    assert.equal(env.queueMessages[0].options.delaySeconds >= 11, true);
  } finally {
    telegram.restore();
  }
});

test("Worker queue handler retries generic message failures without delay options", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv({
    ARTIST_QUEUE: {
      async send() {
        throw new Error("Queue send failed");
      },
    },
  });
  const batch = createQueueBatch([
    {
      chatId: "224032101",
      artistName: "ebi",
      tracks: [
        { permlink: "Ebi-One", title: "One", mediaType: "song" },
        { permlink: "Ebi-Two", title: "Two", mediaType: "song" },
      ],
      total: 2,
      nextIndex: 0,
      sent: 0,
      failed: [],
      sentTrackKeys: [],
    },
  ]);

  try {
    await worker.queue(batch, env, {});
    assert.equal(batch.messages[0].acked, false);
    assert.equal(batch.messages[0].retried, true);
    assert.equal(batch.messages[0].retryOptions, undefined);
  } finally {
    telegram.restore();
  }
});

test("getArtistQueueDelaySeconds has safe defaults and max clamp", () => {
  assert.equal(getArtistQueueDelaySeconds({}), 2);
  assert.equal(getArtistQueueDelaySeconds({ ARTIST_QUEUE_DELAY_SECONDS: "9" }), 9);
  assert.equal(getArtistQueueDelaySeconds({ ARTIST_QUEUE_DELAY_SECONDS: "999" }), 60);
});

test("enqueueArtistQueueDelivery serializes a second artist for the same chat", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv();

  try {
    await enqueueArtistQueueDelivery(env, "224032101", "chaartaar", [
      { permlink: "Chaartaar-One", title: "One", mediaType: "song" },
    ]);
    await enqueueArtistQueueDelivery(env, "224032101", "hichkas", [
      { permlink: "Hichkas-One", title: "One", mediaType: "song" },
    ]);

    assert.equal(env.queueMessages.length, 1);
    assert.equal(env.queueMessages[0].payload.artistName, "chaartaar");
    assert.ok(env.ARTIST_JOB_STORE.store.has("artist-queue-active:v1:224032101"));
    assert.ok(env.ARTIST_JOB_STORE.store.has("artist-queue-pending:v1:224032101"));
    assert.match(telegram.calls.at(-1).init.body, /موقعیت صف/);
    assert.match(telegram.calls.at(-1).init.body, /در انتظار:.*hichkas/);
  } finally {
    telegram.restore();
  }
});

test("enqueueArtistQueueDelivery treats encoded active lock as same artist", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv();
  env.ARTIST_JOB_STORE.store.set(
    "artist-queue-active:v1:224032101",
    JSON.stringify({
      artistName: "Kamran%20%26%20Hooman",
      total: 46,
      startedAt: new Date().toISOString(),
    })
  );

  try {
    await enqueueArtistQueueDelivery(env, "224032101", "Kamran & Hooman", [
      { permlink: "Kamran-Hooman-One", title: "One", mediaType: "song" },
    ]);

    assert.equal(env.queueMessages.length, 0);
    assert.equal(env.ARTIST_JOB_STORE.store.has("artist-queue-pending:v1:224032101"), false);
    assert.match(telegram.calls.at(-1).init.body, /Kamran & Hooman/);
    assert.match(telegram.calls.at(-1).init.body, /همین حالا در حال انجام است/);
    assert.doesNotMatch(telegram.calls.at(-1).init.body, /%20/);
  } finally {
    telegram.restore();
  }
});

test("warm queue payloads force cache writes when sending tracks", async () => {
  const telegram = mockTelegramFetch({ fileId: "warm-file-id" });
  const env = createEnv({ ENABLE_BULK_CACHE_WRITES: "false" });

  try {
    await runQueuedArtistMessage(env, {
      chatId: "224032101",
      artistName: "ebi",
      warmCache: true,
      originalTotal: 10,
      tracks: [{ permlink: "Ebi-Warm", title: "Warm", mediaType: "song" }],
      total: 1,
      nextIndex: 0,
      sent: 0,
      failed: [],
      sentTrackKeys: [],
      createdAt: new Date().toISOString(),
    });

    assert.equal(
      env.TELEGRAM_FILE_CACHE.operations.some(
        (op) => op.type === "put" && String(op.key).includes("ebi-warm")
      ),
      true
    );
    assert.match(telegram.calls.at(-1).init.body, /گرم‌کردن کش ebi تمام شد/);
  } finally {
    telegram.restore();
  }
});

test("runQueuedArtistMessage promotes a pending artist after completion", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv();
  env.ARTIST_JOB_STORE.store.set(
    "artist-queue-active:v1:224032101",
    JSON.stringify({ artistName: "chaartaar", total: 1, startedAt: new Date().toISOString() })
  );
  env.ARTIST_JOB_STORE.store.set(
    "artist-queue-pending:v1:224032101",
    JSON.stringify(
      createQueuedArtistPayload("224032101", "hichkas", [
        { permlink: "Hichkas-One", title: "One", mediaType: "song" },
      ])
    )
  );

  try {
    await runQueuedArtistMessage(env, {
      chatId: "224032101",
      artistName: "chaartaar",
      tracks: [{ permlink: "Chaartaar-One", title: "One", mediaType: "song" }],
      total: 1,
      nextIndex: 0,
      sent: 0,
      failed: [],
      sentTrackKeys: [],
      createdAt: new Date().toISOString(),
    });

    assert.equal(env.queueMessages.length, 1);
    assert.equal(env.queueMessages[0].payload.artistName, "hichkas");
    assert.equal(env.ARTIST_JOB_STORE.store.has("artist-queue-pending:v1:224032101"), false);
    assert.match(JSON.stringify(telegram.calls.map((call) => call.init.body)), /شروع ارسال صف‌شده برای hichkas/);
  } finally {
    telegram.restore();
  }
});

test("Worker DLQ handler auto-retries once before giving up", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv();
  env.ARTIST_JOB_STORE.store.set(
    "artist-queue-active:v1:224032101",
    JSON.stringify({ artistName: "hichkas", total: 35, startedAt: new Date().toISOString() })
  );
  const batch = createQueueBatch(
    [
      {
        chatId: "224032101",
        artistName: "hichkas",
        tracks: [{ permlink: "Hichkas-Seven", title: "Seven", mediaType: "song" }],
        total: 35,
        nextIndex: 6,
        sent: 6,
        failed: [],
        sentTrackKeys: [],
      },
    ],
    ARTIST_DELIVERY_DLQ_NAME
  );

  try {
    await worker.queue(batch, env, {});
    assert.equal(batch.messages[0].acked, true);
    assert.equal(env.queueMessages.length, 1);
    assert.equal(env.queueMessages[0].payload.dlqRetryCount, 1);
    assert.equal(env.ARTIST_JOB_STORE.store.has("artist-queue-active:v1:224032101"), true);
    assert.match(telegram.calls[0].init.body, /یک‌بار دیگر از آهنگ 7\/35/);
  } finally {
    telegram.restore();
  }
});

test("handleArtistDeliveryDlq gives up after one retry and promotes pending", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv();
  env.ARTIST_JOB_STORE.store.set(
    "artist-queue-active:v1:224032101",
    JSON.stringify({ artistName: "hichkas", total: 35, startedAt: new Date().toISOString() })
  );
  env.ARTIST_JOB_STORE.store.set(
    "artist-queue-pending:v1:224032101",
    JSON.stringify(
      createQueuedArtistPayload("224032101", "chaartaar", [
        { permlink: "Chaartaar-One", title: "One", mediaType: "song" },
      ])
    )
  );

  try {
    await handleArtistDeliveryDlq(env, {
      chatId: "224032101",
      artistName: "hichkas",
      tracks: [{ permlink: "Hichkas-Seven", title: "Seven", mediaType: "song" }],
      total: 35,
      nextIndex: 6,
      sent: 6,
      dlqRetryCount: 1,
    });

    assert.equal(env.queueMessages.length, 1);
    assert.equal(env.queueMessages[0].payload.artistName, "chaartaar");
    assert.match(telegram.calls[0].init.body, /بعد از چند خطای پیاپی متوقف شد/);
  } finally {
    telegram.restore();
  }
});
