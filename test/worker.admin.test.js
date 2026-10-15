import assert from "node:assert/strict";
import test from "node:test";

import worker, { processUpdate } from "../worker.js";
import { createEnv, createMockCtx, mockFetch } from "./helpers.js";
import { createAdminSessionValue, buildAdminCookie } from "../src/admin/auth.js";
import { updateUserFlags, isUserBanned } from "../src/admin/users.js";
import { ADMIN_COOKIE_NAME } from "../src/config.js";

function adminEnv(overrides = {}) {
  return createEnv({
    ADMIN_TOKEN: "admin-secret",
    ADMIN_USER_IDS: "224032101",
    ...overrides,
  });
}

async function sessionCookie(env) {
  const value = await createAdminSessionValue(env);
  return `${ADMIN_COOKIE_NAME}=${encodeURIComponent(value)}`;
}

test("admin api rejects unauthorized overview", async () => {
  const env = adminEnv();
  const response = await worker.fetch(
    new Request("https://worker.test/admin/api/overview"),
    env,
    createMockCtx()
  );
  assert.equal(response.status, 401);
});

test("admin overview succeeds with session cookie", async () => {
  const env = adminEnv();
  const fetchMock = mockFetch(({ url }) => {
    if (url.includes("getMe")) {
      return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "rjbot", first_name: "RJ" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  });

  try {
    const cookie = await sessionCookie(env);
    const response = await worker.fetch(
      new Request("https://worker.test/admin/api/overview", {
        headers: { Cookie: cookie },
      }),
      env,
      createMockCtx()
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.bot.username, "rjbot");
    assert.equal(body.config.artistQueue, "telegram-radiojavan-artist-delivery");
  } finally {
    fetchMock.restore();
  }
});

test("admin overview succeeds with bearer ADMIN_TOKEN", async () => {
  const env = adminEnv();
  const fetchMock = mockFetch(({ url }) => {
    if (url.includes("getMe")) {
      return new Response(JSON.stringify({ ok: true, result: { username: "rjbot" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  });
  try {
    const response = await worker.fetch(
      new Request("https://worker.test/admin/api/overview", {
        headers: { Authorization: "Bearer admin-secret" },
      }),
      env,
      createMockCtx()
    );
    assert.equal(response.status, 200);
  } finally {
    fetchMock.restore();
  }
});

test("login sets cookie and logout clears it", async () => {
  const env = adminEnv();
  const login = await worker.fetch(
    new Request("https://worker.test/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "admin-secret" }),
    }),
    env,
    createMockCtx()
  );
  assert.equal(login.status, 200);
  assert.match(login.headers.get("Set-Cookie") || "", /rj_admin_session=/);

  const logout = await worker.fetch(
    new Request("https://worker.test/admin/logout", { method: "POST" }),
    env,
    createMockCtx()
  );
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get("Set-Cookie") || "", /Max-Age=0/);
});

test("banned user is blocked in processUpdate", async () => {
  const env = adminEnv();
  await updateUserFlags(env, "99", { banned: true });
  assert.equal(await isUserBanned(env, "99"), true);

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

  try {
    await processUpdate(
      { message: { chat: { id: 99, type: "private" }, from: { id: 99 }, text: "ebi" } },
      env,
      "https://worker.test"
    );
    assert.match(bodies.join("\n"), /دسترسی شما/);
    assert.equal(bodies.length, 1);
  } finally {
    fetchMock.restore();
  }
});

test("admin can cancel and clear pending for a chat", async () => {
  const env = adminEnv();
  env.ARTIST_JOB_STORE.store.set(
    "artist-queue-active:v1:224032101",
    JSON.stringify({ artistName: "Ebi", total: 10, startedAt: new Date().toISOString() })
  );
  env.ARTIST_JOB_STORE.store.set(
    "artist-queue-pending:v1:224032101",
    JSON.stringify({ artistName: "Chaartaar", tracks: [{ permlink: "a" }], total: 1 })
  );

  const fetchMock = mockFetch(({ url }) => {
    if (url.startsWith("https://api.telegram.org/")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  });

  try {
    const cookie = await sessionCookie(env);
    const clear = await worker.fetch(
      new Request("https://worker.test/admin/api/chat/clear-pending", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: "224032101" }),
      }),
      env,
      createMockCtx()
    );
    assert.equal(clear.status, 200);
    assert.equal(env.ARTIST_JOB_STORE.store.has("artist-queue-pending:v1:224032101"), false);

    const cancel = await worker.fetch(
      new Request("https://worker.test/admin/api/chat/cancel", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: "224032101" }),
      }),
      env,
      createMockCtx()
    );
    assert.equal(cancel.status, 200);
    assert.equal(env.ARTIST_JOB_STORE.store.has("artist-queue-active:v1:224032101"), false);
    assert.equal(env.ARTIST_JOB_STORE.store.has("artist-queue-cancel:v1:224032101"), true);
  } finally {
    fetchMock.restore();
  }
});

test("admin message endpoint sends telegram message", async () => {
  const env = adminEnv();
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
  try {
    const cookie = await sessionCookie(env);
    const response = await worker.fetch(
      new Request("https://worker.test/admin/api/message", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: "224032101", text: "سلام از ادمین" }),
      }),
      env,
      createMockCtx()
    );
    assert.equal(response.status, 200);
    assert.match(bodies.join("\n"), /سلام از ادمین/);
  } finally {
    fetchMock.restore();
  }
});

test("GET /admin shows login without auth and dashboard with auth", async () => {
  const env = adminEnv();
  const loginPage = await worker.fetch(new Request("https://worker.test/admin"), env, createMockCtx());
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Admin password/);

  const cookie = await sessionCookie(env);
  const dash = await worker.fetch(
    new Request("https://worker.test/admin", { headers: { Cookie: cookie } }),
    env,
    createMockCtx()
  );
  assert.equal(dash.status, 200);
  const dashHtml = await dash.text();
  assert.match(dashHtml, /Runtime settings/);
  assert.match(dashHtml, /Known users/);
});

test("buildAdminCookie helper clears session", () => {
  assert.match(buildAdminCookie("", { clear: true }), /Max-Age=0/);
});

test("admin lists known users from profiles and recents", async () => {
  const env = adminEnv();
  await updateUserFlags(env, "111", { banned: false, note: "friend" });
  await updateUserFlags(env, "222", { banned: true, note: "spam" });
  env.ARTIST_JOB_STORE.store.set("user-recent:v1:333", JSON.stringify([{ type: "search", value: "ebi" }]));

  const cookie = await sessionCookie(env);
  const all = await worker.fetch(
    new Request("https://worker.test/admin/api/users", { headers: { Cookie: cookie } }),
    env,
    createMockCtx()
  );
  assert.equal(all.status, 200);
  const body = await all.json();
  const ids = body.users.map((u) => u.chatId).sort();
  assert.deepEqual(ids, ["111", "222", "333"]);

  const banned = await worker.fetch(
    new Request("https://worker.test/admin/api/users?bannedOnly=1", { headers: { Cookie: cookie } }),
    env,
    createMockCtx()
  );
  const bannedBody = await banned.json();
  assert.equal(bannedBody.users.length, 1);
  assert.equal(bannedBody.users[0].chatId, "222");
});

test("admin dlq events endpoint returns recorded events", async () => {
  const { recordDlqEvent } = await import("../src/admin/dlq-log.js");
  const env = adminEnv();
  await recordDlqEvent(
    env,
    { chatId: "224032101", artistName: "Ebi", nextIndex: 3, total: 10, sent: 3, failed: [] },
    { retryCount: 1, autoRetried: false }
  );
  const cookie = await sessionCookie(env);
  const response = await worker.fetch(
    new Request("https://worker.test/admin/api/dlq", { headers: { Cookie: cookie } }),
    env,
    createMockCtx()
  );
  const body = await response.json();
  assert.equal(body.events[0].artistName, "Ebi");
  assert.equal(body.events[0].chatId, "224032101");
});

test("quota blocks downloads and VIP bypasses limit", async () => {
  const { checkAndConsumeQuota, updateUserFlags } = await import("../src/admin/users.js");
  const env = adminEnv({ DEFAULT_DAILY_DOWNLOAD_LIMIT: "2" });
  await updateUserFlags(env, "55", { banned: false });
  assert.equal((await checkAndConsumeQuota(env, "55", 1)).ok, true);
  assert.equal((await checkAndConsumeQuota(env, "55", 1)).ok, true);
  assert.equal((await checkAndConsumeQuota(env, "55", 1)).ok, false);
  await updateUserFlags(env, "55", { vip: true });
  assert.equal((await checkAndConsumeQuota(env, "55", 5)).ok, true);
});

test("admin user id is unlimited without VIP flag", async () => {
  const { checkAndConsumeQuota, updateUserFlags } = await import("../src/admin/users.js");
  const env = adminEnv({ DEFAULT_DAILY_DOWNLOAD_LIMIT: "1", ADMIN_USER_IDS: "224032101" });
  await updateUserFlags(env, "224032101", { vip: false });
  const first = await checkAndConsumeQuota(env, "224032101", 1);
  const second = await checkAndConsumeQuota(env, "224032101", 5);
  assert.equal(first.ok, true);
  assert.equal(first.unlimited, true);
  assert.equal(second.ok, true);
  assert.equal(second.unlimited, true);
  // VIP stays a separate flag — admin unlimited does not set vip
  assert.equal(second.user.vip, false);
});

test("allowlist mode blocks non-allowlisted users but not admins", async () => {
  const { updateUserFlags, isUserAllowed } = await import("../src/admin/users.js");
  const { saveRuntimeConfig, loadRuntimeConfig } = await import("../src/admin/runtime-config.js");
  const env = adminEnv({ ADMIN_USER_IDS: "224032101" });
  await saveRuntimeConfig(env, { allowlistMode: true });
  await loadRuntimeConfig(env, { force: true });
  await updateUserFlags(env, "99", { allowlisted: false });
  await updateUserFlags(env, "88", { allowlisted: true });
  assert.equal(await isUserAllowed(env, "99"), false);
  assert.equal(await isUserAllowed(env, "88"), true);
  assert.equal(await isUserAllowed(env, "224032101"), true);
  await saveRuntimeConfig(env, { allowlistMode: false });
  await loadRuntimeConfig(env, { force: true });
  assert.equal(await isUserAllowed(env, "99"), true);
});

test("runtime config overrides delay and queue pause endpoint works", async () => {
  const { saveRuntimeConfig, loadRuntimeConfig, isQueuePaused } = await import(
    "../src/admin/runtime-config.js"
  );
  const { getArtistQueueDelaySeconds } = await import("../src/config.js");
  const env = adminEnv({ ARTIST_QUEUE_DELAY_SECONDS: "2" });
  await saveRuntimeConfig(env, { artistQueueDelaySeconds: 9, queuePaused: true });
  await loadRuntimeConfig(env, { force: true });
  assert.equal(getArtistQueueDelaySeconds(env), 9);
  assert.equal(isQueuePaused(env), true);

  const cookie = await sessionCookie(env);
  const response = await worker.fetch(
    new Request("https://worker.test/admin/api/runtime", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ queuePaused: false, artistQueueDelaySeconds: null }),
    }),
    env,
    createMockCtx()
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.runtime.queuePaused, false);
  assert.equal(body.runtime.artistQueueDelaySeconds, 2);
});

test("wipe user clears profile and recents", async () => {
  const { updateUserFlags, wipeUser, getUser } = await import("../src/admin/users.js");
  const { pushUserRecent, readUserRecents } = await import("../src/bot/commands.js");
  const env = adminEnv();
  await updateUserFlags(env, "77", { note: "temp", vip: true });
  await pushUserRecent(env, "77", { type: "song", value: "x", label: "x" });
  assert.ok(await getUser(env, "77"));
  assert.equal((await readUserRecents(env, "77")).length, 1);
  await wipeUser(env, "77");
  assert.equal(await getUser(env, "77"), null);
  assert.equal((await readUserRecents(env, "77")).length, 0);
});

test("admin promote-pending and export endpoints work", async () => {
  const env = adminEnv();
  const cookie = await sessionCookie(env);
  env.ARTIST_JOB_STORE.store.set(
    "artist-queue-pending:v1:224032101",
    JSON.stringify({
      chatId: "224032101",
      artistName: "Ebi",
      tracks: [{ permlink: "Ebi-One", title: "One", mediaType: "song" }],
      total: 1,
    })
  );
  const fetchMock = mockFetch(({ url }) => {
    if (url.startsWith("https://api.telegram.org/")) {
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  });
  try {
    const promote = await worker.fetch(
      new Request("https://worker.test/admin/api/chat/promote-pending", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: "224032101" }),
      }),
      env,
      createMockCtx()
    );
    assert.equal(promote.status, 200);
    const body = await promote.json();
    assert.equal(body.promoted, "Ebi");
    assert.equal(env.ARTIST_QUEUE.messages.length > 0, true);

    const exp = await worker.fetch(
      new Request("https://worker.test/admin/api/export?kind=errors", { headers: { Cookie: cookie } }),
      env,
      createMockCtx()
    );
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get("Content-Disposition") || "", /admin-errors\.json/);
  } finally {
    fetchMock.restore();
  }
});

test("admin overview includes webhook and today stats", async () => {
  const env = adminEnv();
  const { incrementStat } = await import("../src/admin/stats.js");
  await incrementStat(env, "songs");
  await incrementStat(env, "searches");
  const fetchMock = mockFetch(({ url }) => {
    if (url.includes("getMe")) {
      return new Response(JSON.stringify({ ok: true, result: { username: "rjbot" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("getWebhookInfo")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: { url: "https://worker.test/webhook", pending_update_count: 2, last_error_message: null },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("{}", { status: 200 });
  });
  try {
    const cookie = await sessionCookie(env);
    const response = await worker.fetch(
      new Request("https://worker.test/admin/api/overview", { headers: { Cookie: cookie } }),
      env,
      createMockCtx()
    );
    const body = await response.json();
    assert.equal(body.webhook.url, "https://worker.test/webhook");
    assert.equal(body.today.songs, 1);
    assert.equal(body.today.searches, 1);
  } finally {
    fetchMock.restore();
  }
});
