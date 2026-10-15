import assert from "node:assert/strict";
import test from "node:test";

import {
  TelegramRateLimitError,
  cacheTelegramFile,
  filterUncachedTracks,
  getCachedTelegramFile,
  getTelegramFileCacheKey,
  sendTrackToUser,
} from "../worker.js";
import { createEnv, createFailingPutKv, createMockKv, makeTrack, mockFetch } from "./helpers.js";

function telegramResponse(result = { audio: { file_id: "new-file-id" } }) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("cache keys are lowercase and legacy casing still resolves", async () => {
  const track = makeTrack("Ebi-Cached");
  assert.equal(getTelegramFileCacheKey(track, "320"), "telegram-file:v1:song:song:ebi-cached:320");

  const legacyKey = "telegram-file:v1:song:song:Ebi-Cached:320";
  const kv = createMockKv({
    [legacyKey]: JSON.stringify({ fileId: "legacy-id", permlink: "Ebi-Cached", quality: "320" }),
  });
  const env = createEnv({ TELEGRAM_FILE_CACHE: kv });

  const cached = await getCachedTelegramFile(env, track, "320");
  assert.equal(cached.fileId, "legacy-id");
  assert.equal(kv.store.has("telegram-file:v1:song:song:ebi-cached:320"), true);
});

test("sendTrackToUser sends cached file_id without uploading", async () => {
  const track = makeTrack("Ebi-Cached");
  const cacheKey = "telegram-file:v1:song:song:ebi-cached:320";
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
  const cacheKey = "telegram-file:v1:song:song:ebi-rejected:320";
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
    assert.equal(
      kv.operations.some((op) => op.type === "put" && String(op.key).includes("ebi-upload")),
      true
    );
  } finally {
    fetchMock.restore();
  }
});

test("artist delivery can read cache but skip new cache writes", async () => {
  const track = makeTrack("Ebi-NoBulkCache");
  const kv = createMockKv();
  const env = createEnv({ TELEGRAM_FILE_CACHE: kv });
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
  const cacheKey = "telegram-file:v1:song:song:ebi-badcache:320";
  const kv = createMockKv({ [cacheKey]: JSON.stringify({ fileId: "" }) });
  const env = createEnv({ TELEGRAM_FILE_CACHE: kv });

  assert.equal(await getCachedTelegramFile(env, track, "320"), null);
  assert.equal(kv.store.has(cacheKey), false);
});

test("filterUncachedTracks keeps only songs missing from TELEGRAM_FILE_CACHE", async () => {
  const cached = makeTrack("Ebi-Cached");
  const missing = makeTrack("Ebi-Missing");
  const env = createEnv({
    TELEGRAM_FILE_CACHE: createMockKv({
      "telegram-file:v1:song:song:ebi-cached:320": JSON.stringify({ fileId: "id" }),
    }),
  });

  const result = await filterUncachedTracks(env, [cached, missing]);
  assert.deepEqual(
    result.map((track) => track.permlink),
    ["Ebi-Missing"]
  );
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

test("sendTrackToUser skips dead hosts after Telegram URL content failures", async () => {
  const track = makeTrack("Ebi-DeadHost", {
    urls: [
      "https://host2.rj-mw1.com/media/mp3/mp3-320/Ebi-DeadHost.mp3",
      "https://host2.rj-mw1.com/media/mp3/mp3-320/ebi-deadhost.mp3",
      "https://host1.rj-mw1.com/media/mp3/mp3-320/Ebi-DeadHost.mp3",
    ],
  });
  const env = createEnv({
    TELEGRAM_FILE_CACHE: createMockKv(),
    MAX_AUDIO_URL_ATTEMPTS: "3",
  });
  const attempted = [];

  const fetchMock = mockFetch(({ url, init }) => {
    if (url.includes("api.telegram.org")) {
      const body = typeof init.body === "string" ? init.body : "";
      const audioMatch = body.match(/"audio":"(https:[^"]+)"/);
      if (audioMatch) {
        attempted.push(audioMatch[1]);
        if (audioMatch[1].includes("host2.rj-mw1.com")) {
          return new Response(
            JSON.stringify({ ok: false, description: "Bad Request: failed to get HTTP URL content" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        return telegramResponse({ audio: { file_id: "good-id" } });
      }
      return telegramResponse();
    }

    return new Response("audio-bytes".repeat(20), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", "content-length": "400" },
    });
  });

  try {
    await sendTrackToUser("chat", track, env, { preferUrl: true, cacheUploads: false, maxUrlAttempts: 3 });
    assert.ok(attempted.some((url) => url.includes("host2.rj-mw1.com")));
    assert.ok(attempted.some((url) => url.includes("host1.rj-mw1.com")));
    assert.equal(attempted.filter((url) => url.includes("host2.rj-mw1.com")).length, 1);
  } finally {
    fetchMock.restore();
  }
});
