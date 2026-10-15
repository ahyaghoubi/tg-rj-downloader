import {
  ARTIST_DELIVERY_QUEUE_NAME,
  ARTIST_DELIVERY_DLQ_NAME,
  ADMIN_DLQ_EVENTS_KEY,
  getBotToken,
  getJobStore,
  getFileCacheStore,
  getAdminUserIds,
  getArtistQueueDelaySeconds,
  getArtistProgressEvery,
  getMaxAudioUrlAttempts,
  getDefaultDailyDownloadLimit,
  shouldCacheArtistUploads,
  queueChatActiveKey,
  queueChatPendingKey,
  queueChatCancelKey,
  putKv,
} from "../config.js";
import { normalizeArtistName, normalizeInput, parseMediaFromUrl } from "../rj/urls.js";
import { sendMessage, sendTrackToUser } from "../telegram/send.js";
import { cancelChatArtistDelivery, readUserRecents } from "../bot/commands.js";
import { warmArtistMissingTracks } from "../delivery/warm.js";
import { promotePendingQueueChatDelivery } from "../delivery/queue.js";
import { enqueueBulkDelivery } from "../bot/artist-menu.js";
import { searchRadioJavan } from "../bot/search.js";
import {
  fetchArtistCatalog,
  fetchPlaylistTracks,
  fetchAlbumTracks,
  selectArtistTracks,
  resolveDownloadUrls,
} from "../rj/tracks.js";
import {
  getUser,
  updateUserFlags,
  listKnownUsers,
  clearUserRecents,
  wipeUser,
} from "./users.js";
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
import {
  loadRuntimeConfig,
  saveRuntimeConfig,
  effectiveConfigSnapshot,
} from "./runtime-config.js";
import { makeStartPayload, buildBotStartLink } from "../bot/start-payload.js";
import {
  getCachedTelegramFile,
  deleteCachedTelegramFile,
  getTelegramFileCacheKey,
} from "../cache/telegram-file.js";

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
  await loadRuntimeConfig(env);
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
      runtime: effectiveConfigSnapshot(env),
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

function summarizeTracks(tracks, sample = 5) {
  const list = Array.isArray(tracks) ? tracks : [];
  const mapTrack = (track) => ({
    permlink: track.permlink || null,
    title: track.title || track.song || track.permlink || null,
    artist: track.artist || null,
  });
  return {
    count: list.length,
    first: list.slice(0, sample).map(mapTrack),
    last: list.length > sample ? list.slice(-sample).map(mapTrack) : [],
  };
}

async function handlePromotePending(env, chatId) {
  const kv = getJobStore(env);
  if (!kv) {
    return jsonResponse({ ok: false, error: "ARTIST_JOB_STORE missing" }, 500);
  }
  const pendingRaw = await kv.get(queueChatPendingKey(chatId));
  if (!pendingRaw) {
    return jsonResponse({ ok: false, error: "no pending job" }, 404);
  }
  let pendingArtist = null;
  try {
    pendingArtist = normalizeArtistName(JSON.parse(pendingRaw)?.artistName || "") || null;
  } catch (_) {
    // ignore
  }
  // Stop active without wiping pending, then promote.
  try {
    await putKv(
      kv,
      queueChatCancelKey(chatId),
      JSON.stringify({ cancelledAt: new Date().toISOString() }),
      { expirationTtl: 60 * 60 }
    );
    await kv.delete(queueChatActiveKey(chatId));
  } catch (err) {
    console.warn(`promote pending prep failed: ${err.message}`);
  }
  await promotePendingQueueChatDelivery(env, String(chatId));
  return jsonResponse({
    ok: true,
    chatId: String(chatId),
    promoted: pendingArtist,
  });
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

  if (path === "/admin/api/chat/promote-pending" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const chatId = body.chatId;
    if (!chatId) {
      return jsonResponse({ ok: false, error: "chatId required" }, 400);
    }
    const result = await handlePromotePending(env, String(chatId));
    await recordAdminAudit(env, { action: "chat.promote-pending", chatId });
    return result;
  }

  if (path === "/admin/api/resolve" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const input = String(body.url || body.value || "").trim();
    if (!input) {
      return jsonResponse({ ok: false, error: "url required" }, 400);
    }
    try {
      const normalized = normalizeInput(input);
      const parsed = parseMediaFromUrl(normalized);
      return jsonResponse({
        ok: true,
        input,
        normalized,
        mediaType: parsed.mediaType,
        mediaName: parsed.mediaName,
        playlistSubtype: parsed.playlistSubtype || null,
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 400);
    }
  }

  if (path === "/admin/api/preview" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const type = String(body.type || "artist").trim().toLowerCase();
    const value = normalizeArtistName(body.value || body.artistName || body.id || "");
    if (!value) {
      return jsonResponse({ ok: false, error: "value required" }, 400);
    }
    try {
      let tracks = [];
      let meta = { type, value };
      if (type === "artist" || type === "a") {
        const catalog = await fetchArtistCatalog(env, value);
        tracks = catalog.tracks || [];
        meta.playlists = (catalog.playlists || []).slice(0, 10).map((p) => ({
          id: p.id,
          title: p.title,
          count: p.count || null,
        }));
      } else if (type === "playlist" || type === "p") {
        tracks = await fetchPlaylistTracks(env, value);
      } else if (type === "album" || type === "b") {
        tracks = await fetchAlbumTracks(env, value);
      } else {
        return jsonResponse({ ok: false, error: "type must be artist|playlist|album" }, 400);
      }
      return jsonResponse({ ok: true, ...meta, tracks: summarizeTracks(tracks) });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  }

  if (path === "/admin/api/search" && request.method === "GET") {
    const query = url.searchParams.get("q") || url.searchParams.get("query") || "";
    if (!String(query).trim()) {
      return jsonResponse({ ok: false, error: "q required" }, 400);
    }
    try {
      const results = await searchRadioJavan(env, query);
      return jsonResponse({
        ok: true,
        query: String(query).trim(),
        artists: (results.artists || []).slice(0, 10),
        songs: (results.songs || []).slice(0, 15),
        playlists: (results.playlists || []).slice(0, 10),
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  }

  if (path === "/admin/api/send-artist" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const chatId = body.chatId;
    const artistName = normalizeArtistName(body.artistName || body.artist || "");
    const limitRaw = body.limit;
    const limit =
      limitRaw == null || limitRaw === "" || limitRaw === "all"
        ? null
        : Math.max(1, Math.min(Number(limitRaw) || 0, 500));
    if (!chatId || !artistName) {
      return jsonResponse({ ok: false, error: "chatId and artistName required" }, 400);
    }
    if (!env.ARTIST_QUEUE) {
      return jsonResponse({ ok: false, error: "ARTIST_QUEUE is not configured" }, 500);
    }
    try {
      const catalog = await fetchArtistCatalog(env, artistName);
      const tracks = selectArtistTracks(catalog.tracks, limit);
      if (!tracks.length) {
        return jsonResponse({ ok: false, error: "no tracks found" }, 404);
      }
      const label = limit ? `${artistName} (آخرین ${tracks.length})` : artistName;
      ctx.waitUntil(enqueueBulkDelivery(env, String(chatId), label, tracks, { skipQuota: true }));
      await recordAdminAudit(env, {
        action: "send-artist",
        chatId,
        detail: `${artistName}:${limit == null ? "all" : limit}`,
      });
      return jsonResponse({
        ok: true,
        chatId: String(chatId),
        artistName,
        limit,
        trackCount: tracks.length,
        preview: summarizeTracks(tracks, 3),
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  }

  if (path === "/admin/api/test-message" && request.method === "POST") {
    const admins = getAdminUserIds(env);
    if (!admins.length) {
      return jsonResponse({ ok: false, error: "ADMIN_USER_IDS empty" }, 400);
    }
    const body = await readJsonOrForm(request);
    const text =
      String(body.text || "").trim() ||
      `تست ادمین · ${new Date().toISOString()} · bot ok`;
    const results = [];
    for (const chatId of admins) {
      try {
        await sendMessage(chatId, text, getBotToken(env));
        results.push({ chatId, ok: true });
      } catch (err) {
        results.push({ chatId, ok: false, error: err.message });
      }
    }
    await recordAdminAudit(env, { action: "test-message", detail: text.slice(0, 80) });
    return jsonResponse({ ok: results.every((r) => r.ok), results });
  }

  if (path === "/admin/api/export" && request.method === "GET") {
    const kind = url.searchParams.get("kind") || "errors";
    let events = [];
    if (kind === "dlq") {
      events = await readDlqEvents(env);
    } else if (kind === "audit") {
      events = await readAdminAudit(env);
    } else {
      events = await readAdminErrors(env);
    }
    return new Response(JSON.stringify({ kind, exportedAt: new Date().toISOString(), events }, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="admin-${kind}.json"`,
      },
    });
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
    if (typeof body.allowlisted === "boolean") {
      patch.allowlisted = body.allowlisted;
    } else if (body.allowlisted === "true" || body.allowlisted === "false") {
      patch.allowlisted = body.allowlisted === "true";
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
          allowlisted: user.allowlisted,
          dailyDownloadLimit: user.dailyDownloadLimit,
        }),
      });
      return jsonResponse({ ok: true, user });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  }

  if (path === "/admin/api/user/clear-recents" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const chatId = body.chatId;
    if (!chatId) {
      return jsonResponse({ ok: false, error: "chatId required" }, 400);
    }
    const result = await clearUserRecents(env, String(chatId));
    await recordAdminAudit(env, { action: "user.clear-recents", chatId });
    return jsonResponse(result);
  }

  if (path === "/admin/api/user/wipe" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const chatId = body.chatId;
    if (!chatId) {
      return jsonResponse({ ok: false, error: "chatId required" }, 400);
    }
    const result = await wipeUser(env, String(chatId));
    await recordAdminAudit(env, { action: "user.wipe", chatId });
    return jsonResponse(result);
  }

  if (path === "/admin/api/runtime" && request.method === "GET") {
    await loadRuntimeConfig(env);
    return jsonResponse({ ok: true, runtime: effectiveConfigSnapshot(env) });
  }

  if (path === "/admin/api/runtime" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const patch = {};
    if (typeof body.allowlistMode === "boolean") {
      patch.allowlistMode = body.allowlistMode;
    } else if (body.allowlistMode === "true" || body.allowlistMode === "false") {
      patch.allowlistMode = body.allowlistMode === "true";
    }
    if (typeof body.queuePaused === "boolean") {
      patch.queuePaused = body.queuePaused;
    } else if (body.queuePaused === "true" || body.queuePaused === "false") {
      patch.queuePaused = body.queuePaused === "true";
    }
    for (const key of [
      "artistQueueDelaySeconds",
      "artistProgressEvery",
      "maxAudioUrlAttempts",
      "defaultDailyDownloadLimit",
    ]) {
      if (body[key] === null || body[key] === "") {
        patch[key] = null;
      } else if (body[key] != null) {
        patch[key] = Number(body[key]);
      }
    }
    if (body.enableBulkCacheWrites === null || body.enableBulkCacheWrites === "") {
      patch.enableBulkCacheWrites = null;
    } else if (typeof body.enableBulkCacheWrites === "boolean") {
      patch.enableBulkCacheWrites = body.enableBulkCacheWrites;
    } else if (body.enableBulkCacheWrites === "true" || body.enableBulkCacheWrites === "false") {
      patch.enableBulkCacheWrites = body.enableBulkCacheWrites === "true";
    }
    try {
      const saved = await saveRuntimeConfig(env, patch);
      await recordAdminAudit(env, {
        action: "runtime.update",
        detail: JSON.stringify(patch),
      });
      return jsonResponse({ ok: true, runtime: effectiveConfigSnapshot(env), saved });
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

  if (path === "/admin/api/dlq/discard" && request.method === "POST") {
    const body = await readJsonOrForm(request);
    const index = Number(body.index);
    const kv = getJobStore(env);
    if (!kv) {
      return jsonResponse({ ok: false, error: "ARTIST_JOB_STORE missing" }, 500);
    }
    const events = await readDlqEvents(env);
    if (!Number.isFinite(index) || index < 0 || index >= events.length) {
      return jsonResponse({ ok: false, error: "invalid index" }, 400);
    }
    const [removed] = events.splice(index, 1);
    await putKv(kv, ADMIN_DLQ_EVENTS_KEY, JSON.stringify(events), {
      expirationTtl: 90 * 24 * 60 * 60,
    });
    await recordAdminAudit(env, {
      action: "dlq.discard",
      chatId: removed?.chatId,
      detail: removed?.artistName || null,
    });
    return jsonResponse({ ok: true, removed, remaining: events.length });
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
