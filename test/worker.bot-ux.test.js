import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  cancelChatArtistDelivery,
  handleInlineQuery,
  isAdminUser,
  parseBotCommand,
  processUpdate,
  runQueuedArtistMessage,
  searchRadioJavan,
} from "../worker.js";
import { createEnv, createMockCtx, mockFetch, mockTelegramFetch } from "./helpers.js";

function searchAndTelegramFetch() {
  return mockFetch(({ url }) => {
    if (url.startsWith("https://api.telegram.org/")) {
      const method = url.split("/").pop();
      const result =
        method === "sendMessage"
          ? { message_id: 1 }
          : method === "answerInlineQuery" || method === "answerCallbackQuery"
            ? true
            : { audio: { file_id: "id" } };
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/api/p/search?")) {
      return new Response(
        JSON.stringify({
          artists: [{ name: "Ebi", query: "Ebi", type: "artist" }],
          mp3s: [
            {
              permlink: "Ebi-Gheseh-Eshgh",
              title: 'Ebi - "Gheseh Eshgh"',
              artist: "Ebi",
              song: "Gheseh Eshgh",
              link: "https://cdn.example.com/media/mp3/mp3-320/Ebi-Gheseh-Eshgh.mp3",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("/api/p/artist?")) {
      return new Response(
        JSON.stringify({
          songs: [
            {
              permlink: "Ebi-One",
              title: "One",
              link: "https://cdn.example.com/media/mp3/mp3-320/Ebi-One.mp3",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("/api/p/mp3?")) {
      return new Response(
        JSON.stringify({
          permlink: "Ebi-Gheseh-Eshgh",
          title: "Gheseh Eshgh",
          link: "https://cdn.example.com/media/mp3/mp3-320/Ebi-Gheseh-Eshgh.mp3",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("", { status: 404 });
  });
}

test("parseBotCommand extracts command name and args", () => {
  assert.deepEqual(parseBotCommand("/search ebi love"), { name: "search", arg: "ebi love" });
  assert.deepEqual(parseBotCommand("/help@MyBot"), { name: "help", arg: "" });
  assert.equal(parseBotCommand("not a command"), null);
});

test("searchRadioJavan maps artists and songs", async () => {
  const fetchMock = searchAndTelegramFetch();
  try {
    const result = await searchRadioJavan(createEnv(), "ebi");
    assert.equal(result.artists[0].query, "Ebi");
    assert.equal(result.songs[0].permlink, "Ebi-Gheseh-Eshgh");
  } finally {
    fetchMock.restore();
  }
});

test("processUpdate /help and plain-text search send keyboard results", async () => {
  const telegramBodies = [];
  const fetchMock = mockFetch(({ url, init }) => {
    if (url.startsWith("https://api.telegram.org/")) {
      telegramBodies.push(init.body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/p/search?")) {
      return new Response(
        JSON.stringify({
          artists: [{ name: "Ebi", query: "Ebi" }],
          mp3s: [{ permlink: "Ebi-One", title: "One", artist: "Ebi", song: "One", link: "https://x/a.mp3" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const env = createEnv({ ADMIN_USER_IDS: "224032101" });

  try {
    await processUpdate({ message: { chat: { id: 1 }, text: "/help" } }, env, "https://worker.test");
    assert.match(telegramBodies.at(-1), /\/search/);

    await processUpdate({ message: { chat: { id: 1 }, text: "ebi" } }, env, "https://worker.test");
    assert.match(telegramBodies.join("\n"), /نتایج جستجو/);
    assert.match(telegramBodies.join("\n"), /inline_keyboard/);
    assert.equal(env.ARTIST_JOB_STORE.store.has("user-recent:v1:1"), true);
  } finally {
    fetchMock.restore();
  }
});

test("callback query for song schedules download path via handleUrl", async () => {
  const ctx = createMockCtx();
  const fetchMock = searchAndTelegramFetch();
  const env = createEnv({ JOB_RUNNER_SECRET: "secret" });

  try {
    const response = await worker.fetch(
      new Request("https://worker.test/webhook", {
        method: "POST",
        body: JSON.stringify({
          callback_query: {
            id: "cb1",
            data: "s:Ebi-Gheseh-Eshgh",
            from: { id: 224032101 },
            message: { chat: { id: 224032101 } },
          },
        }),
      }),
      env,
      ctx
    );
    assert.equal(response.status, 200);
    await ctx.flush();
  } finally {
    fetchMock.restore();
  }
});

test("inline query returns article results", async () => {
  const fetchMock = searchAndTelegramFetch();
  const env = createEnv();
  try {
    await handleInlineQuery({ id: "iq1", query: "ebi", from: { id: 224032101 } }, env);
    const body = fetchMock.calls.find((call) => call.url.includes("answerInlineQuery"))?.init.body;
    assert.match(body, /خواننده: Ebi/);
    assert.match(body, /play\.radiojavan\.com\/song\/Ebi-Gheseh-Eshgh/);
  } finally {
    fetchMock.restore();
  }
});

test("cancel stops an in-flight queue delivery", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv();
  env.ARTIST_JOB_STORE.store.set(
    "artist-queue-active:v1:224032101",
    JSON.stringify({ artistName: "ebi", total: 1, startedAt: new Date().toISOString() })
  );
  try {
    await cancelChatArtistDelivery(env, "224032101");
    assert.equal(env.ARTIST_JOB_STORE.store.has("artist-queue-cancel:v1:224032101"), true);
    assert.match(telegram.calls.map((call) => call.init.body).join("\n"), /لغو ebi/);

    await runQueuedArtistMessage(env, {
      chatId: "224032101",
      artistName: "ebi",
      tracks: [{ permlink: "Ebi-One", title: "One", mediaType: "song" }],
      total: 1,
      nextIndex: 0,
      sent: 0,
      failed: [],
      sentTrackKeys: [],
      createdAt: new Date(Date.now() - 1000).toISOString(),
    });

    assert.equal(env.queueMessages.length, 0);
    assert.equal(env.ARTIST_JOB_STORE.store.has("artist-queue-cancel:v1:224032101"), true);

    // A newer delivery started after cancel should still be allowed.
    await runQueuedArtistMessage(env, {
      chatId: "224032101",
      artistName: "ebi",
      tracks: [{ permlink: "Ebi-Two", title: "Two", mediaType: "song" }],
      total: 1,
      nextIndex: 0,
      sent: 0,
      failed: [],
      sentTrackKeys: [],
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    assert.match(telegram.calls.at(-1).init.body, /ارسال ebi تمام شد/);
  } finally {
    telegram.restore();
  }
});

test("admin status is restricted and available to configured admins", async () => {
  assert.equal(isAdminUser({ ADMIN_USER_IDS: "224032101" }, "224032101"), true);
  assert.equal(isAdminUser({ ADMIN_USER_IDS: "224032101" }, "1"), false);

  const bodies = [];
  const fetchMock = mockFetch(({ url, init }) => {
    if (url.includes("sendMessage")) {
      bodies.push(init.body);
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const env = createEnv({ ADMIN_USER_IDS: "224032101" });
  try {
    await processUpdate(
      { message: { chat: { id: 1 }, from: { id: 1 }, text: "/status" } },
      env,
      "https://worker.test"
    );
    assert.match(bodies.at(-1), /فقط برای ادمین/);

    await processUpdate(
      { message: { chat: { id: 224032101 }, from: { id: 224032101 }, text: "/status" } },
      env,
      "https://worker.test"
    );
    assert.match(bodies.at(-1), /وضعیت ادمین/);
    assert.match(bodies.at(-1), /artistDlq|dlq/i);
  } finally {
    fetchMock.restore();
  }
});

test("progress message is sent every N songs", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv({ ARTIST_PROGRESS_EVERY: "1" });
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
    });
    assert.match(telegram.calls.map((call) => call.init.body).join("\n"), /پیشرفت: 1\/2/);
  } finally {
    telegram.restore();
  }
});
