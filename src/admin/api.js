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
import { getUser, updateUserFlags, listKnownUsers } from "./users.js";
import {
  buildAdminCookie,
  createAdminSessionValue,
  isAdminAuthorized,
  passwordFromRequestBody,
} from "./auth.js";
import { renderAdminPage, renderLoginPage } from "./page.js";
import { readDlqEvents } from "./dlq-log.js";
import { readDailyStats, readRecentDailyStats } from "./stats.js";
import { recordAdminAudit, readAdminErrors, readAdminAudit } from "./ops-log.js";
import { makeStartPayload, buildBotStartLink } from "../bot/start-payload.js";
import { resolveDownloadUrls } from "../rj/tracks.js";
import { sendTrackToUser } from "../telegram/send.js";
import {
  getCachedTelegramFile,
  deleteCachedTelegramFile,
  getTelegramFileCacheKey,
} from "../cache/telegram-file.js";
import { getFileCacheStore, getDefaultDailyDownloadLimit } from "../config.js";

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
  let webhook = null;
  if (token) {
    try {
      const [meRes, hookRes] = await Promise.all([
        fetch(`https://api.telegram.org/bot${token}/getMe`),
        fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`),
      ]);
      const me = await meRes.json();
      const hook = await hookRes.json();
      botOk = Boolean(me.ok);
      bot = me.result || null;
      botError = me.ok ? null : me.description;
      if (hook.ok && hook.result) {
        webhook = {
          url: hook.result.url || "",
          pendingUpdateCount: hook.result.pending_update_count || 0,
          lastErrorMessage: hook.result.last_error_message || null,
          lastErrorDate: hook.result.last_error_date || null,
        };
      }
    } catch (err) {
      botError = err.message;
    }
  } else {
    botError = "BOT_TOKEN not configured";
  }

  const [today, recentStats, errors, audit] = await Promise.all([
    readDailyStats(env),
    readRecentDailyStats(env, 7),
    readAdminErrors(env),
    readAdminAudit(env),
  ]);

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
    webhook,
    today,
    recentStats,
    recentErrors: errors.slice(0, 10),
    recentAudit: audit.slice(0, 10),
    config: {
      artistQueue: ARTIST_DELIVERY_QUEUE_NAME,
      artistDlq: ARTIST_DELIVERY_DLQ_NAME,
      bulkCacheWrites: shouldCacheArtistUploads(env),
      queueDelaySeconds: getArtistQueueDelaySeconds(env),
      progressEvery: getArtistProgressEvery(env),
      maxAudioUrlAttempts: getMaxAudioUrlAttempts(env),
      defaultDailyDownloadLimit: getDefaultDailyDownloadLimit(env),
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
    await recordAdminAudit(env, { action: "chat.cancel", chatId, detail: result.activeArtist });
    return jsonResponse({ ok: true, ...result, chatId: String(chatId) });
  }

  if (path === "/admin/api/chat/clear-pending" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const chatId = body.chatId;
    if (!chatId) {
      return jsonResponse({ ok: false, error: "chatId required" }, 400);
    }
    const result = await handleClearPending(env, String(chatId));
    await recordAdminAudit(env, { action: "chat.clear-pending", chatId });
    return result;
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
    await recordAdminAudit(env, { action: "warm", chatId, detail: artistName });
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
    if (typeof body.vip === "boolean") {
      patch.vip = body.vip;
    } else if (body.vip === "true" || body.vip === "false") {
      patch.vip = body.vip === "true";
    }
    if (typeof body.note === "string") {
      patch.note = body.note;
    }
    if (body.dailyDownloadLimit === null || body.dailyDownloadLimit === "") {
      patch.dailyDownloadLimit = null;
    } else if (body.dailyDownloadLimit != null) {
      patch.dailyDownloadLimit = Number(body.dailyDownloadLimit);
    }
    try {
      const user = await updateUserFlags(env, String(chatId), patch);
      await recordAdminAudit(env, {
        action: "user.update",
        chatId,
        detail: JSON.stringify({
          banned: user.banned,
          vip: user.vip,
          dailyDownloadLimit: user.dailyDownloadLimit,
        }),
      });
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
      await recordAdminAudit(env, { action: "message", chatId, detail: text.slice(0, 80) });
      return jsonResponse({ ok: true, chatId: String(chatId) });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  }

  if (path === "/admin/api/send-song" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const chatId = body.chatId;
    const permlink = String(body.permlink || "").trim();
    if (!chatId || !permlink) {
      return jsonResponse({ ok: false, error: "chatId and permlink required" }, 400);
    }
    try {
      const resolved = await resolveDownloadUrls(env, "song", permlink);
      if (!resolved.urls?.length) {
        return jsonResponse({ ok: false, error: "No download URLs for song" }, 404);
      }
      const track = {
        permlink,
        title: resolved.title || permlink,
        artist: resolved.artist || "",
        duration: resolved.duration || null,
        mediaType: "song",
        urls: resolved.urls,
      };
      await sendTrackToUser(chatId, track, env, { preferUrl: true, cacheUploads: true });
      await recordAdminAudit(env, { action: "send-song", chatId, detail: permlink });
      return jsonResponse({ ok: true, chatId: String(chatId), permlink });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  }

  if (path === "/admin/api/deep-link" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const type = String(body.type || "s").trim();
    const value = String(body.value || "").trim();
    if (!value) {
      return jsonResponse({ ok: false, error: "value required" }, 400);
    }
    const payload = await makeStartPayload(env, type, value);
    const url = await buildBotStartLink(env, type, value);
    await recordAdminAudit(env, { action: "deep-link", detail: `${type}:${value}` });
    return jsonResponse({ ok: true, type, value, payload, url });
  }

  if (path === "/admin/api/errors" && request.method === "GET") {
    return jsonResponse({ ok: true, events: await readAdminErrors(env) });
  }

  if (path === "/admin/api/audit" && request.method === "GET") {
    return jsonResponse({ ok: true, events: await readAdminAudit(env) });
  }

  if (path === "/admin/api/users" && request.method === "GET") {
    const bannedOnly = url.searchParams.get("bannedOnly") === "1";
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);
    const users = await listKnownUsers(env, { limit, bannedOnly });
    return jsonResponse({ ok: true, users, count: users.length });
  }

  if (path === "/admin/api/dlq" && request.method === "GET") {
    const events = await readDlqEvents(env);
    return jsonResponse({ ok: true, events });
  }

  if (path === "/admin/api/cache" && request.method === "GET") {
    const permlink = url.searchParams.get("permlink");
    if (!permlink) {
      return jsonResponse({ ok: false, error: "permlink required" }, 400);
    }
    const track = { permlink, mediaType: "song" };
    const qualities = ["320", "256"];
    const entries = [];
    for (const quality of qualities) {
      const cached = await getCachedTelegramFile(env, track, quality);
      entries.push({
        quality,
        key: getTelegramFileCacheKey(track, quality),
        hit: Boolean(cached),
        record: cached
          ? {
              fileId: cached.fileId,
              title: cached.title || null,
              sourceUrl: cached.sourceUrl || null,
              cachedAt: cached.cachedAt || null,
            }
          : null,
      });
    }
    return jsonResponse({
      ok: true,
      permlink,
      hasFileCache: Boolean(getFileCacheStore(env)),
      entries,
    });
  }

  if (path === "/admin/api/cache/delete" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const permlink = body.permlink;
    const quality = body.quality || "320";
    if (!permlink) {
      return jsonResponse({ ok: false, error: "permlink required" }, 400);
    }
    await deleteCachedTelegramFile(env, { permlink, mediaType: "song" }, String(quality));
    if (!body.quality) {
      await deleteCachedTelegramFile(env, { permlink, mediaType: "song" }, "256");
    }
    await recordAdminAudit(env, { action: "cache.delete", detail: permlink });
    return jsonResponse({ ok: true, permlink, quality: body.quality || "320+256" });
  }

  return jsonResponse({ ok: false, error: "Not found" }, 404);
}

export { handleAdminRequest, handleOverview, readChatJobState };
