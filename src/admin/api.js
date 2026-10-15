import {
  ARTIST_DELIVERY_QUEUE_NAME,
  ARTIST_DELIVERY_DLQ_NAME,
  getBotToken,
  getJobStore,
  getAdminUserIds,
  getArtistQueueDelaySeconds,
  getArtistProgressEvery,
  getMaxAudioUrlAttempts,
  shouldCacheArtistUploads,
  queueChatActiveKey,
  queueChatPendingKey,
  queueChatCancelKey,
} from "../config.js";
import { normalizeArtistName } from "../rj/urls.js";
import { sendMessage } from "../telegram/send.js";
import { cancelChatArtistDelivery, readUserRecents } from "../bot/commands.js";
import { warmArtistMissingTracks } from "../delivery/warm.js";
import { getUser, updateUserFlags } from "./users.js";
import {
  buildAdminCookie,
  createAdminSessionValue,
  isAdminAuthorized,
  passwordFromRequestBody,
} from "./auth.js";
import { renderAdminPage, renderLoginPage } from "./page.js";

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function htmlResponse(html, status = 200, headers = {}) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

async function requireAdmin(request, env) {
  if (await isAdminAuthorized(request, env)) {
    return null;
  }
  return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
}

async function readJsonOrForm(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (/application\/json/i.test(contentType)) {
    return request.json().catch(() => ({}));
  }
  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const body = {};
    for (const [key, value] of params.entries()) {
      body[key] = value;
    }
    body.__raw = text;
    body.__contentType = contentType;
    return body;
  }
  return {};
}

async function handleAdminLogin(request, env) {
  const contentType = request.headers.get("Content-Type") || "";
  let password = "";
  if (/application\/json/i.test(contentType)) {
    const body = await request.json().catch(() => ({}));
    password = passwordFromRequestBody(body, contentType);
  } else {
    const text = await request.text();
    password = passwordFromRequestBody(text, contentType);
  }

  const secret = env.ADMIN_TOKEN?.trim() || "";
  if (!secret || password !== secret) {
    if (/application\/json/i.test(contentType)) {
      return jsonResponse({ ok: false, error: "Invalid password" }, 401);
    }
    return htmlResponse(renderLoginPage({ error: "رمز نادرست است." }), 401);
  }

  const session = await createAdminSessionValue(env);
  const headers = { "Set-Cookie": buildAdminCookie(session) };
  if (/application\/json/i.test(contentType)) {
    return jsonResponse({ ok: true }, 200, headers);
  }
  return new Response(null, {
    status: 303,
    headers: { ...headers, Location: "/admin" },
  });
}

async function handleAdminLogout() {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/admin",
      "Set-Cookie": buildAdminCookie("", { clear: true }),
    },
  });
}

async function handleOverview(env) {
  const token = getBotToken(env);
  let bot = null;
  let botOk = false;
  let botError = null;
  if (token) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const result = await response.json();
      botOk = Boolean(result.ok);
      bot = result.result || null;
      botError = result.ok ? null : result.description;
    } catch (err) {
      botError = err.message;
    }
  } else {
    botError = "BOT_TOKEN not configured";
  }

  return jsonResponse({
    ok: botOk,
    bot: bot
      ? {
          id: bot.id,
          username: bot.username,
          firstName: bot.first_name,
        }
      : null,
    error: botError,
    config: {
      artistQueue: ARTIST_DELIVERY_QUEUE_NAME,
      artistDlq: ARTIST_DELIVERY_DLQ_NAME,
      bulkCacheWrites: shouldCacheArtistUploads(env),
      queueDelaySeconds: getArtistQueueDelaySeconds(env),
      progressEvery: getArtistProgressEvery(env),
      maxAudioUrlAttempts: getMaxAudioUrlAttempts(env),
      adminUserIds: getAdminUserIds(env),
      hasArtistQueue: Boolean(env.ARTIST_QUEUE),
      hasJobStore: Boolean(getJobStore(env)),
      hasFileCache: Boolean(env.TELEGRAM_FILE_CACHE),
    },
  });
}

async function readChatJobState(env, chatId) {
  const kv = getJobStore(env);
  let active = null;
  let pending = null;
  let cancel = null;
  if (kv) {
    try {
      const activeRaw = await kv.get(queueChatActiveKey(chatId));
      const pendingRaw = await kv.get(queueChatPendingKey(chatId));
      const cancelRaw = await kv.get(queueChatCancelKey(chatId));
      active = activeRaw ? JSON.parse(activeRaw) : null;
      pending = pendingRaw ? JSON.parse(pendingRaw) : null;
      cancel = cancelRaw ? JSON.parse(cancelRaw) : cancelRaw ? { raw: true } : null;
      if (active?.artistName) {
        active.artistName = normalizeArtistName(active.artistName);
      }
      if (pending?.artistName) {
        pending.artistName = normalizeArtistName(pending.artistName);
      }
    } catch (err) {
      console.warn(`readChatJobState failed: ${err.message}`);
    }
  }
  return { active, pending, cancel };
}

async function handleChatLookup(env, chatId) {
  const [job, recents, user] = await Promise.all([
    readChatJobState(env, chatId),
    readUserRecents(env, chatId),
    getUser(env, chatId),
  ]);
  return jsonResponse({
    ok: true,
    chatId: String(chatId),
    ...job,
    recents,
    user,
  });
}

async function handleClearPending(env, chatId) {
  const kv = getJobStore(env);
  if (!kv) {
    return jsonResponse({ ok: false, error: "ARTIST_JOB_STORE missing" }, 500);
  }
  await kv.delete(queueChatPendingKey(chatId));
  return jsonResponse({ ok: true, chatId: String(chatId), cleared: "pending" });
}

async function handleAdminRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/admin/login" && request.method === "POST") {
    return handleAdminLogin(request, env);
  }

  if (path === "/admin/logout" && (request.method === "POST" || request.method === "GET")) {
    return handleAdminLogout();
  }

  if (path === "/admin" && request.method === "GET") {
    if (!(await isAdminAuthorized(request, env))) {
      return htmlResponse(renderLoginPage());
    }
    return htmlResponse(renderAdminPage());
  }

  if (!path.startsWith("/admin/api/")) {
    return null;
  }

  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) {
    return unauthorized;
  }

  if (path === "/admin/api/overview" && request.method === "GET") {
    return handleOverview(env);
  }

  if (path === "/admin/api/chat" && request.method === "GET") {
    const chatId = url.searchParams.get("chatId");
    if (!chatId) {
      return jsonResponse({ ok: false, error: "chatId required" }, 400);
    }
    return handleChatLookup(env, chatId);
  }

  if (path === "/admin/api/chat/cancel" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const chatId = body.chatId;
    if (!chatId) {
      return jsonResponse({ ok: false, error: "chatId required" }, 400);
    }
    const result = await cancelChatArtistDelivery(env, String(chatId));
    return jsonResponse({ ok: true, ...result, chatId: String(chatId) });
  }

  if (path === "/admin/api/chat/clear-pending" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const chatId = body.chatId;
    if (!chatId) {
      return jsonResponse({ ok: false, error: "chatId required" }, 400);
    }
    return handleClearPending(env, String(chatId));
  }

  if (path === "/admin/api/warm" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const chatId = body.chatId;
    const artistName = normalizeArtistName(body.artistName || body.artist || "");
    if (!chatId || !artistName) {
      return jsonResponse({ ok: false, error: "chatId and artistName required" }, 400);
    }
    if (!env.ARTIST_QUEUE) {
      return jsonResponse({ ok: false, error: "ARTIST_QUEUE is not configured" }, 500);
    }
    ctx.waitUntil(warmArtistMissingTracks(env, String(chatId), artistName));
    return jsonResponse({
      ok: true,
      mode: "warm-missing-only",
      chatId: String(chatId),
      artistName,
    });
  }

  if (path === "/admin/api/user" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const chatId = body.chatId;
    if (!chatId) {
      return jsonResponse({ ok: false, error: "chatId required" }, 400);
    }
    const patch = {};
    if (typeof body.banned === "boolean") {
      patch.banned = body.banned;
    } else if (body.banned === "true" || body.banned === "false") {
      patch.banned = body.banned === "true";
    }
    if (typeof body.note === "string") {
      patch.note = body.note;
    }
    try {
      const user = await updateUserFlags(env, String(chatId), patch);
      return jsonResponse({ ok: true, user });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  }

  if (path === "/admin/api/message" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const chatId = body.chatId;
    const text = String(body.text || "").trim();
    if (!chatId || !text) {
      return jsonResponse({ ok: false, error: "chatId and text required" }, 400);
    }
    try {
      await sendMessage(chatId, text, getBotToken(env));
      return jsonResponse({ ok: true, chatId: String(chatId) });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  }

  return jsonResponse({ ok: false, error: "Not found" }, 404);
}

export { handleAdminRequest, handleOverview, readChatJobState };
