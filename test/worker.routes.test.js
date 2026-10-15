import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.js";
import { createEnv, createMockCtx, mockFetch, mockRadioJavanAndTelegramFetch } from "./helpers.js";

test("/health returns 500 when BOT_TOKEN is missing", async () => {
  const response = await worker.fetch(
    new Request("https://worker.test/health"),
    createEnv({ BOT_TOKEN: "" }),
    createMockCtx()
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: "BOT_TOKEN not configured" });
});

test("/health calls Telegram getMe when BOT_TOKEN is configured", async () => {
  const fetchMock = mockFetch(() =>
    new Response(JSON.stringify({ ok: true, result: { username: "testbot" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );

  try {
    const response = await worker.fetch(
      new Request("https://worker.test/health"),
      createEnv(),
      createMockCtx()
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.bot, "testbot");
    assert.equal(body.error, null);
    assert.equal(body.artistDlq, "telegram-radiojavan-artist-delivery-dlq");
    assert.equal(body.bulkCacheWrites, false);
    assert.match(fetchMock.calls[0].url, /getMe$/);
  } finally {
    fetchMock.restore();
  }
});

test("root and missing direct parameters return expected responses", async () => {
  const env = createEnv();
  const root = await worker.fetch(new Request("https://worker.test/"), env, createMockCtx());
  const missing = await worker.fetch(new Request("https://worker.test/?link=x"), env, createMockCtx());

  assert.equal(root.status, 200);
  assert.equal(await root.text(), "Cloudflare Worker for Telegram Bot is running!");
  assert.equal(missing.status, 400);
});

test("direct artist GET schedules background handling through waitUntil", async () => {
  const ctx = createMockCtx();
  const fetchMock = mockRadioJavanAndTelegramFetch({
    artistPayload: {
      songs: [
        {
          permlink: "Ebi-One",
          title: "One",
          link: "https://cdn.example.com/media/mp3/mp3-320/Ebi-One.mp3",
        },
      ],
    },
  });

  try {
    const response = await worker.fetch(
      new Request(
        "https://worker.test/?userid=224032101&link=https%3A%2F%2Fplay.radiojavan.com%2Fartist%2Febi"
      ),
      createEnv(),
      ctx
    );

    assert.equal(response.status, 200);
    assert.equal(ctx.promises.length, 1);
    await ctx.flush();
  } finally {
    fetchMock.restore();
  }
});

test("webhook accepts Telegram updates and schedules processing", async () => {
  const ctx = createMockCtx();
  const fetchMock = mockRadioJavanAndTelegramFetch({
    artistPayload: {
      songs: [
        {
          permlink: "Ebi-One",
          title: "One",
          link: "https://cdn.example.com/media/mp3/mp3-320/Ebi-One.mp3",
        },
      ],
    },
  });

  try {
    const response = await worker.fetch(
      new Request("https://worker.test/webhook", {
        method: "POST",
        body: JSON.stringify({
          message: {
            chat: { id: 224032101 },
            text: "https://play.radiojavan.com/artist/ebi",
          },
        }),
      }),
      createEnv(),
      ctx
    );

    assert.equal(response.status, 200);
    assert.equal(ctx.promises.length, 1);
    await ctx.flush();
  } finally {
    fetchMock.restore();
  }
});

test("internal routes reject missing or invalid job runner secret", async () => {
  const env = createEnv({ JOB_RUNNER_SECRET: "secret" });
  const warmResponse = await worker.fetch(
    new Request("https://worker.test/internal/warm-artist?chatId=1&artist=ebi", {
      method: "POST",
    }),
    env,
    createMockCtx()
  );
  const removedJob = await worker.fetch(
    new Request("https://worker.test/internal/run-artist-job?id=job-1", { method: "POST" }),
    env,
    createMockCtx()
  );

  assert.equal(warmResponse.status, 403);
  assert.equal(removedJob.status, 404);
});

test("internal warm-artist schedules missing-only cache warm", async () => {
  const ctx = createMockCtx();
  const env = createEnv({ JOB_RUNNER_SECRET: "secret" });
  env.TELEGRAM_FILE_CACHE.store.set(
    "telegram-file:v1:song:song:ebi-one:320",
    JSON.stringify({ fileId: "cached" })
  );

  const fetchMock = mockRadioJavanAndTelegramFetch({
    artistPayload: {
      songs: [
        {
          permlink: "Ebi-One",
          title: "One",
          link: "https://cdn.example.com/media/mp3/mp3-320/Ebi-One.mp3",
        },
        {
          permlink: "Ebi-Two",
          title: "Two",
          link: "https://cdn.example.com/media/mp3/mp3-320/Ebi-Two.mp3",
        },
      ],
    },
  });

  try {
    const response = await worker.fetch(
      new Request("https://worker.test/internal/warm-artist", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ chatId: "224032101", artistName: "ebi" }),
      }),
      env,
      ctx
    );

    assert.equal(response.status, 200);
    assert.equal(ctx.promises.length, 1);
    await ctx.flush();
    assert.equal(env.queueMessages.length, 1);
    assert.equal(env.queueMessages[0].payload.warmCache, true);
    assert.equal(env.queueMessages[0].payload.total, 1);
    assert.equal(env.queueMessages[0].payload.tracks[0].permlink, "Ebi-Two");
    assert.equal(env.queueMessages[0].payload.originalTotal, 2);
  } finally {
    fetchMock.restore();
  }
});
