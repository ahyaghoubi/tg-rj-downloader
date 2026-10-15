import {
  ARTIST_DELIVERY_QUEUE_NAME,
  ARTIST_DELIVERY_DLQ_NAME,
  getBotToken,
  getMaxAudioUrlAttempts,
  shouldCacheArtistUploads,
} from "../config.js";
import { processUpdate } from "../bot/update.js";
import { handleUrl } from "../bot/handle-url.js";
import { warmArtistMissingTracks } from "../delivery/warm.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getBearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function handleHealth(env) {
  const token = getBotToken(env);
  if (!token) {
    return jsonResponse({ ok: false, error: "BOT_TOKEN not configured" }, 500);
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const result = await response.json();

  return jsonResponse(
    {
      ok: result.ok,
      bot: result.result?.username || null,
      error: result.ok ? null : result.description,
      artistQueue: ARTIST_DELIVERY_QUEUE_NAME,
      artistDlq: ARTIST_DELIVERY_DLQ_NAME,
      bulkCacheWrites: shouldCacheArtistUploads(env),
      maxAudioUrlAttempts: getMaxAudioUrlAttempts(env),
      ops: {
        inspectDlq: `npx wrangler tail && watch ${ARTIST_DELIVERY_DLQ_NAME}`,
        warmArtist: "POST /internal/warm-artist with Bearer JOB_RUNNER_SECRET",
        note: "Do not try to cache the entire Radio Javan catalog on the free KV write quota (~1000 writes/day).",
      },
    },
    result.ok ? 200 : 500
  );
}

async function handleHttpRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname === "/internal/warm-artist") {
    const secret = env.JOB_RUNNER_SECRET;
    if (!secret || getBearerToken(request) !== secret) {
      return new Response("Forbidden", { status: 403 });
    }

    let chatId = url.searchParams.get("chatId") || url.searchParams.get("userid");
    let artistName = url.searchParams.get("artist") || url.searchParams.get("artistName");
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      chatId = body.chatId || body.userid || chatId;
      artistName = body.artistName || body.artist || artistName;
    }

    if (!chatId || !artistName) {
      return new Response("Missing chatId/userid or artistName/artist", { status: 400 });
    }
    if (!env.ARTIST_QUEUE) {
      return new Response("ARTIST_QUEUE is not configured", { status: 500 });
    }

    ctx.waitUntil(warmArtistMissingTracks(env, String(chatId), String(artistName)));
    return jsonResponse({
      ok: true,
      mode: "warm-missing-only",
      chatId: String(chatId),
      artistName: String(artistName),
    });
  }

  if (request.method === "POST" && url.pathname === "/webhook") {
    const token = getBotToken(env);
    if (!token) {
      console.error("BOT_TOKEN is not configured");
      return new Response("BOT_TOKEN not configured", { status: 500 });
    }

    const update = await request.json();
    ctx.waitUntil(processUpdate(update, env, url.origin));
    return new Response("OK", { status: 200 });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return handleHealth(env);
  }

  if (request.method === "GET" && url.pathname === "/") {
    const link = url.searchParams.get("link");
    const userid = url.searchParams.get("userid");

    if (!link && !userid) {
      return new Response("Cloudflare Worker for Telegram Bot is running!", {
        status: 200,
      });
    }

    if (!link || !userid) {
      return new Response("Missing 'link' or 'userid' parameter", { status: 400 });
    }

    if (!getBotToken(env)) {
      return new Response("BOT_TOKEN not configured", { status: 500 });
    }

    ctx.waitUntil(handleUrl(userid, link, env, url.origin));
    return new Response("File processing initiated", { status: 200 });
  }

  return new Response("Not found", { status: 404 });
}

export { jsonResponse, getBearerToken, handleHealth, handleHttpRequest };
