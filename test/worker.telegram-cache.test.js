import assert from "node:assert/strict";
import test from "node:test";

import {
  TelegramRateLimitError,
  cacheTelegramFile,
  getCachedTelegramFile,
  sendTrackToUser,
} from "../worker.js";
import { createEnv, createFailingPutKv, createMockKv, makeTrack, mockFetch } from "./helpers.js";

function telegramResponse(result = { audio: { file_id: "new-file-id" } }) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("sendTrackToUser sends cached file_id without uploading", async () => {
  const track = makeTrack("Ebi-Cached");
  const cacheKey = "telegram-file:v1:song:song:Ebi-Cached:320";
  const env = createEnv({
    TELEGRAM_FILE_CACHE: createMockKv({
      [cacheKey]: JSON.stringify({ fileId: "cached-id" }),
    }),
  });

  const fetchMock = mockFetch(({ url, init }) => {
    assert.match(url, /sendAudio$/);
    assert.match(init.body, /cached-id/);
    return telegramResponse({ audio: { file_id: "cached-id" } });
  });

  try {
    await sendTrackToUser("chat", track, env, { preferUrl: true });
    assert.equal(fetchMock.calls.length, 1);
  } finally {
    fetchMock.restore();
  }
});

test("rejected cached file_id is deleted and URL fallback is attempted", async () => {
  const track = makeTrack("Ebi-Rejected");
  const cacheKey = "telegram-file:v1:song:song:Ebi-Rejected:320";
  const kv = createMockKv({
    [cacheKey]: JSON.stringify({ fileId: "bad-cached-id" }),
  });
  const env = createEnv({ TELEGRAM_FILE_CACHE: kv });
  let callCount = 0;

  const fetchMock = mockFetch(({ init }) => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(JSON.stringify({ ok: false, description: "Bad Request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    assert.match(init.body, /Ebi-Rejected\.mp3/);
    return telegramResponse();
  });

  try {
    await sendTrackToUser("chat", track, env, { preferUrl: true, cacheUploads: false });
    assert.equal(kv.store.has(cacheKey), false);
    assert.equal(fetchMock.calls.length, 2);
  } finally {
    fetchMock.restore();
  }
});

test("single-song upload writes Telegram file cache", async () => {
  const track = makeTrack("Ebi-Upload");
  const kv = createMockKv();
  const env = createEnv({ TELEGRAM_FILE_CACHE: kv });
  const fetchMock = mockFetch(() => telegramResponse({ audio: { file_id: "uploaded-id" } }));

  try {
    await sendTrackToUser("chat", track, env, { preferUrl: true, cacheUploads: true });
    assert.equal(kv.operations.some((op) => op.type === "put" && op.key.includes("Ebi-Upload")), true);
  } finally {
    fetchMock.restore();
  }
});

test("artist delivery can read cache but skip new cache writes", async () => {
  const track = makeTrack("Ebi-NoBulkCache");
  const kv = createMockKv();
  const env = createEnv({ TELEGRAM_FILE_CACHE: kv, ENABLE_BULK_CACHE_WRITES: "false" });
  const fetchMock = mockFetch(() => telegramResponse({ audio: { file_id: "artist-upload-id" } }));

  try {
    await sendTrackToUser("chat", track, env, { preferUrl: true, cacheUploads: false });
    assert.equal(kv.operations.some((op) => op.type === "get"), true);
    assert.equal(kv.operations.some((op) => op.type === "put"), false);
  } finally {
    fetchMock.restore();
  }
});

test("cacheTelegramFile swallows KV write quota errors", async () => {
  const kv = createFailingPutKv();
  const env = createEnv({ TELEGRAM_FILE_CACHE: kv });

  await cacheTelegramFile(env, makeTrack("Ebi-KvQuota"), "320", "file-id", "https://x/mp3-320/a.mp3");
  assert.equal(kv.operations.some((op) => op.type === "put"), true);
});

test("getCachedTelegramFile deletes malformed cache records", async () => {
  const track = makeTrack("Ebi-BadCache");
  const cacheKey = "telegram-file:v1:song:song:Ebi-BadCache:320";
  const kv = createMockKv({ [cacheKey]: JSON.stringify({ fileId: "" }) });
  const env = createEnv({ TELEGRAM_FILE_CACHE: kv });

  assert.equal(await getCachedTelegramFile(env, track, "320"), null);
  assert.equal(kv.store.has(cacheKey), false);
});

test("Telegram 429 becomes TelegramRateLimitError with retry_after", async () => {
  const env = createEnv({ TELEGRAM_FILE_CACHE: createMockKv() });
  const fetchMock = mockFetch(() =>
    new Response(
      JSON.stringify({
        ok: false,
        description: "Too Many Requests",
        parameters: { retry_after: 23 },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    )
  );

  try {
    await assert.rejects(
      () => sendTrackToUser("chat", makeTrack("Ebi-RateLimit"), env, { preferUrl: true }),
      (err) => err instanceof TelegramRateLimitError && err.retryAfter === 23
    );
  } finally {
    fetchMock.restore();
  }
});
