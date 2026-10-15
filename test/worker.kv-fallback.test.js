import assert from "node:assert/strict";
import test from "node:test";

import { createStatelessArtistPayload, runStatelessArtistBatch, runWatchdog } from "../worker.js";
import { createEnv, createMockCtx, createMockKv, makeTrack, mockTelegramFetch } from "./helpers.js";

test("createStatelessArtistPayload initializes no-KV artist progress", () => {
  const tracks = [makeTrack("Ebi-One"), makeTrack("Ebi-Two")];
  const payload = createStatelessArtistPayload("224032101", "ebi", tracks);

  assert.equal(payload.chatId, "224032101");
  assert.equal(payload.artistName, "ebi");
  assert.equal(payload.total, 2);
  assert.equal(payload.nextIndex, 0);
  assert.deepEqual(payload.failed, []);
  assert.deepEqual(payload.sentTrackKeys, []);
});

test("runStatelessArtistBatch completes final track without continuation", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv();

  try {
    await runStatelessArtistBatch(
      env,
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
      "https://worker.test"
    );

    assert.equal(telegram.calls.length, 2);
    assert.match(telegram.calls[1].init.body, /ارسال ebi تمام شد/);
  } finally {
    telegram.restore();
  }
});

test("runWatchdog safely no-ops when ARTIST_JOB_STORE is missing", async () => {
  const ctx = createMockCtx();
  await runWatchdog(createEnv({ ARTIST_JOB_STORE: undefined }), ctx);
  assert.equal(ctx.promises.length, 0);
});

test("runWatchdog resumes active legacy job and completes it with TTL metadata", async () => {
  const telegram = mockTelegramFetch();
  const kv = createMockKv({
    "artist-jobs-active:v1": JSON.stringify(["job-1"]),
    "artist-job-active:v1:224032101": "job-1",
    "artist-job:v1:job-1": JSON.stringify({
      id: "job-1",
      chatId: "224032101",
      artistName: "ebi",
      tracks: [{ permlink: "Ebi-One", title: "One", mediaType: "song" }],
      total: 1,
      nextIndex: 0,
      sent: 0,
      sentTrackKeys: [],
      failed: [],
      status: "pending",
      lockedUntil: null,
      runAfter: null,
      retryCountByTrack: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  });
  const ctx = createMockCtx();

  try {
    await runWatchdog(createEnv({ ARTIST_JOB_STORE: kv, JOB_RUNNER_SECRET: "secret" }), ctx);
    assert.equal(ctx.promises.length, 1);
    await ctx.flush();

    const completedPut = kv.operations.find(
      (op) => op.type === "put" && op.key === "artist-job:v1:job-1" && op.options?.expirationTtl
    );
    assert.ok(completedPut);
    assert.equal(kv.store.get("artist-jobs-active:v1"), "[]");
  } finally {
    telegram.restore();
  }
});
