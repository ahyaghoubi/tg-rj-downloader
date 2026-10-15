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
  assert.match(await loginPage.text(), /رمز ادمین/);

  const cookie = await sessionCookie(env);
  const dash = await worker.fetch(
    new Request("https://worker.test/admin", { headers: { Cookie: cookie } }),
    env,
    createMockCtx()
  );
  assert.equal(dash.status, 200);
  assert.match(await dash.text(), /گرم‌کردن کش/);
});

test("buildAdminCookie helper clears session", () => {
  assert.match(buildAdminCookie("", { clear: true }), /Max-Age=0/);
});
