import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  TelegramRateLimitError,
  compactQueuedTrack,
  createQueuedArtistPayload,
  getArtistQueueDelaySeconds,
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
    assert.match(telegram.calls[1].init.body, /Done with ebi/);
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
    assert.match(telegram.calls[1].init.body, /Done with ebi/);
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

test("Worker queue handler retries Telegram 429 with retry_after delay", async () => {
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
    assert.equal(batch.messages[0].acked, false);
    assert.equal(batch.messages[0].retried, true);
    assert.deepEqual(batch.messages[0].retryOptions, { delaySeconds: 11 });
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
