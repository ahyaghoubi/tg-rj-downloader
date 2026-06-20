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
    assert.deepEqual(await response.json(), { ok: true, bot: "testbot", error: null });
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
  const jobResponse = await worker.fetch(
    new Request("https://worker.test/internal/run-artist-job?id=job-1", { method: "POST" }),
    env,
    createMockCtx()
  );
  const statelessResponse = await worker.fetch(
    new Request("https://worker.test/internal/run-artist-stateless", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
      body: "{}",
    }),
    env,
    createMockCtx()
  );

  assert.equal(jobResponse.status, 403);
  assert.equal(statelessResponse.status, 403);
});

test("internal stateless route accepts valid secret and schedules fallback work", async () => {
  const ctx = createMockCtx();
  const telegram = mockFetch(() =>
    new Response(JSON.stringify({ ok: true, result: { audio: { file_id: "id" } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );

  try {
    const response = await worker.fetch(
      new Request("https://worker.test/internal/run-artist-stateless", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: JSON.stringify({
          chatId: "224032101",
          artistName: "ebi",
          tracks: [{ permlink: "Ebi-One", title: "One", mediaType: "song" }],
          total: 1,
          nextIndex: 0,
          sent: 0,
          failed: [],
          sentTrackKeys: [],
        }),
      }),
      createEnv({ JOB_RUNNER_SECRET: "secret" }),
      ctx
    );

    assert.equal(response.status, 200);
    assert.equal(ctx.promises.length, 1);
    await ctx.flush();
  } finally {
    telegram.restore();
  }
});
