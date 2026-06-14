export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/webhook") {
        const token = getBotToken(env);
        if (!token) {
          console.error("BOT_TOKEN is not configured");
          return new Response("BOT_TOKEN not configured", { status: 500 });
        }

        const update = await request.json();
        ctx.waitUntil(processUpdate(update, env));
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

        ctx.waitUntil(handleUrl(userid, link, env));
        return new Response("File processing initiated", { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(`Error: ${err.message}`);
      return new Response("Error: Unable to process your request.", {
        status: 500,
      });
    }
  },
};

const RJ_DEFAULTS = {
  API_KEY: "40e87948bd4ef75efe61205ac5f468a9fd2b970511acf58c49706ecb984f1d67",
  USER_AGENT:
    "Radio Javan/4.0.2/f6173917bde5c0102c894b5d2e478693c9d750b7 com.radioJavan.rj.web",
  BROWSER_UA:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ORIGIN: "https://play.radiojavan.com",
};

const MEDIA_HOSTS = [
  "host2.rj-mw1.com",
  "host1.rj-mw1.com",
  "host2.rjapp-content.app",
  "host1.rjapp-content.app",
];

const MEDIA_PATH_TEMPLATES = {
  song: [
    ["media/mp3/mp3-320", "mp3"],
    ["media/mp3/mp3-256", "mp3"],
  ],
};

function upgradeTo320Url(url) {
  if (typeof url !== "string" || /mp3-320/i.test(url)) {
    return null;
  }
  if (/mp3-256/i.test(url)) {
    return url.replace("/mp3-256/", "/mp3-320/");
  }
  return null;
}

function getMp3QualityRank(url) {
  if (/mp3-320/i.test(url)) {
    return 0;
  }
  if (/mp3-256/i.test(url)) {
    return 1;
  }
  if (/\.mp3(\?|$)/i.test(url)) {
    return 2;
  }
  if (/aac-256/i.test(url)) {
    return 3;
  }
  if (/aac-128/i.test(url)) {
    return 4;
  }
  return 5;
}

function orderSongUrls(urls) {
  return [...new Set(urls)].sort((a, b) => getMp3QualityRank(a) - getMp3QualityRank(b));
}

function collectRawUrlsFromTrack(track) {
  const urls = [];
  for (const key of ["link", "hq_link", "lq_link"]) {
    const value = track[key];
    if (typeof value === "string" && value.startsWith("http") && !urls.includes(value)) {
      urls.push(value);
    }
  }
  return urls;
}

function resolveSongUrls(mediaType, permlink, apiUrls = []) {
  const candidates = [];

  const push = (url) => {
    if (typeof url === "string" && url.startsWith("http") && !candidates.includes(url)) {
      candidates.push(url);
    }
  };

  for (const url of buildFallbackUrls(mediaType, permlink)) {
    push(url);
  }

  for (const url of apiUrls) {
    push(url);
    const upgraded = upgradeTo320Url(url);
    if (upgraded) {
      push(upgraded);
    }
  }

  return orderSongUrls(candidates);
}

const API_MEDIA_TYPES = {
  song: "mp3",
};

function isSupportedMediaType(mediaType) {
  return mediaType === "song";
}

function isSkippedTrack(item) {
  if (item?.type === "video" || item?.type === "podcast") {
    return true;
  }

  for (const key of ["link", "hq_link", "lq_link"]) {
    const value = item?.[key];
    if (typeof value !== "string") {
      continue;
    }
    if (/\.mp4(\?|$)/i.test(value) || /music_video/i.test(value)) {
      return true;
    }
    if (/\/podcast\//i.test(value)) {
      return true;
    }
  }

  return false;
}

const MIN_FILE_SIZE = 100;
const MAX_ARTIST_AUDIO_FILES = 50;

function getBotToken(env) {
  return env.BOT_TOKEN?.trim() || "";
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
    },
    result.ok ? 200 : 500
  );
}

function normalizeInput(text) {
  const trimmed = text.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^(?:www\.)?(?:play\.)?radiojavan\.com\//i.test(trimmed) || /^rj\.app\//i.test(trimmed)) {
    return `https://${trimmed.replace(/^\/+/, "")}`;
  }
  return trimmed;
}

function extractLinkFromMessage(message) {
  if (!message?.text) {
    return null;
  }

  const normalized = normalizeInput(message.text);
  if (
    normalized.startsWith("http") ||
    normalized.includes("radiojavan.com") ||
    normalized.startsWith("rj.app")
  ) {
    return normalized;
  }

  if (message.entities) {
    for (const entity of message.entities) {
      if (entity.type === "url") {
        return normalizeInput(message.text.slice(entity.offset, entity.offset + entity.length));
      }
    }
  }

  return null;
}

function getRjCredentials(env) {
  return {
    apiKey: env.RJ_API_KEY || RJ_DEFAULTS.API_KEY,
    userAgent: env.RJ_USER_AGENT || RJ_DEFAULTS.USER_AGENT,
  };
}

function getRadioJavanApiHeaders(env, refererPath) {
  const { apiKey, userAgent } = getRjCredentials(env);
  return {
    "User-Agent": RJ_DEFAULTS.BROWSER_UA,
    Referer: `${RJ_DEFAULTS.ORIGIN}${refererPath}`,
    Origin: RJ_DEFAULTS.ORIGIN,
    Accept: "application/json, text/plain, */*",
    "x-api-key": apiKey,
    "x-rj-user-agent": userAgent,
  };
}

function parseMediaFromUrl(link) {
  const parsed = new URL(link);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`Invalid URL format: ${link}`);
  }
  return {
    mediaType: segments[0],
    mediaName: segments[1],
  };
}

function extractArtistName(link) {
  const { mediaName } = parseMediaFromUrl(link);
  return mediaName;
}

function buildFallbackUrls(mediaType, permlink) {
  const templates = MEDIA_PATH_TEMPLATES[mediaType];
  if (!templates) {
    return [];
  }

  const names = [permlink];
  const lower = permlink.toLowerCase();
  if (lower !== permlink) {
    names.push(lower);
  }

  const urls = [];
  for (const host of MEDIA_HOSTS) {
    for (const [path, ext] of templates) {
      for (const name of names) {
        const url = `https://${host}/${path}/${name}.${ext}`;
        if (!urls.includes(url)) {
          urls.push(url);
        }
      }
    }
  }
  return urls;
}

function trackFromApiItem(item, mediaType) {
  if (!item?.permlink) {
    return null;
  }

  const rawUrls = collectRawUrlsFromTrack(item);
  return {
    permlink: item.permlink,
    title: item.title || item.song || item.permlink,
    mediaType,
    urls: resolveSongUrls(mediaType, item.permlink, rawUrls),
  };
}

function extractTracksFromPayload(data) {
  const tracks = [];
  const seen = new Set();

  const visit = (obj) => {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        visit(item);
      }
      return;
    }

    if (!obj || typeof obj !== "object") {
      return;
    }

    const hasDirectLink = Boolean(obj.link || obj.hq_link || obj.lq_link);
    if (typeof obj.permlink === "string" && hasDirectLink && !isSkippedTrack(obj)) {
      const key = obj.permlink.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        tracks.push(trackFromApiItem(obj, "song"));
      }
    }

    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        visit(value);
      }
    }
  };

  visit(data);
  return tracks;
}

async function fetchRadioJavanApi(env, endpoint, refererPath) {
  const response = await fetch(`${RJ_DEFAULTS.ORIGIN}${endpoint}`, {
    method: "GET",
    headers: getRadioJavanApiHeaders(env, refererPath),
  });

  if (!response.ok) {
    throw new Error(`Non-OK HTTP status: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchArtistTracks(env, artistName) {
  const refererPath = `/artist/${artistName}/songs`;
  const endpoints = [
    `/api/p/artist?query=${encodeURIComponent(artistName)}&v=2`,
    `/api/p/artist?query=${encodeURIComponent(artistName)}`,
  ];

  let lastError;
  for (const endpoint of endpoints) {
    try {
      const data = await fetchRadioJavanApi(env, endpoint, refererPath);
      const tracks = extractTracksFromPayload(data);
      if (tracks.length) {
        return tracks;
      }
    } catch (err) {
      lastError = err;
      console.warn(`Artist API attempt failed (${endpoint}): ${err.message}`);
    }
  }

  throw lastError || new Error("No tracks found for artist");
}

async function fetchMediaTrack(env, mediaType, permlink) {
  const apiType = API_MEDIA_TYPES[mediaType];
  if (!apiType) {
    return null;
  }

  const refererPath = `/${mediaType}/${permlink}`;
  try {
    const data = await fetchRadioJavanApi(
      env,
      `/api/p/${apiType}?id=${encodeURIComponent(permlink)}`,
      refererPath
    );
    return trackFromApiItem(data, mediaType);
  } catch (err) {
    console.warn(`Metadata API failed for ${mediaType}/${permlink}: ${err.message}`);
    return null;
  }
}

async function resolveDownloadUrls(env, mediaType, permlink, knownUrls = []) {
  const track = await fetchMediaTrack(env, mediaType, permlink);
  const apiUrls = [...knownUrls];
  if (track) {
    for (const url of track.urls) {
      if (!apiUrls.includes(url)) {
        apiUrls.push(url);
      }
    }
  }

  const urls = resolveSongUrls(mediaType, permlink, apiUrls);
  return { urls, title: track?.title || permlink };
}

async function isValidMediaUrl(url) {
  const headers = {
    "User-Agent": RJ_DEFAULTS.BROWSER_UA,
    Accept: "*/*",
  };

  try {
    let response = await fetch(url, { method: "HEAD", headers, redirect: "follow" });
    if (!response.ok) {
      response = await fetch(url, { method: "GET", headers, redirect: "follow" });
    }

    if (!response.ok) {
      return false;
    }

    const length = Number(response.headers.get("content-length") || 0);
    if (length > 0 && length < MIN_FILE_SIZE) {
      return false;
    }

    if (response.body) {
      await response.body.cancel();
    }
    return true;
  } catch (err) {
    console.warn(`Validation failed for ${url}: ${err.message}`);
    return false;
  }
}

async function fetchFileAsBlob(urls) {
  for (const url of urls) {
    try {
      if (!(await isValidMediaUrl(url))) {
        continue;
      }

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": RJ_DEFAULTS.BROWSER_UA,
          Referer: url,
          Accept: "*/*",
        },
        redirect: "follow",
      });

      if (!response.ok) {
        console.warn(`Failed to fetch from ${url}: HTTP ${response.status}`);
        continue;
      }

      const blob = await response.blob();
      if (blob.size >= MIN_FILE_SIZE) {
        return { blob, url };
      }

      console.warn(`Unusually small file (${blob.size} bytes) from ${url}`);
    } catch (err) {
      console.error(`Error fetching from ${url}: ${err.message}`);
    }
  }

  throw new Error("Failed to fetch file from all provided URLs.");
}

function getTrackDownloadUrl(track) {
  const urls = resolveSongUrls(track.mediaType, track.permlink, track.urls);
  const url320 = urls.find((url) => /mp3-320/i.test(url));
  const url256 = urls.find((url) => /mp3-256/i.test(url));
  return url320 || url256 || urls[0] || `${RJ_DEFAULTS.ORIGIN}/song/${track.permlink}`;
}

function buildArtistLinksFile(artistName, tracks) {
  const lines = tracks.map((track) => {
    const title = track.title || track.permlink;
    const urls = resolveSongUrls(track.mediaType, track.permlink, track.urls);
    const url320 = urls.find((url) => /mp3-320/i.test(url));
    const url256 = urls.find((url) => /mp3-256/i.test(url));

    if (url320 && url256 && url320 !== url256) {
      return `${title}\n320: ${url320}\n256: ${url256}`;
    }

    return `${title}\n${url320 || url256 || urls[0]}`;
  });

  return `${artistName} — ${tracks.length} songs\n\n${lines.join("\n\n")}`;
}

async function sendArtistTracksAsAudio(userId, tracks, env) {
  const token = getBotToken(env);
  let sent = 0;
  const failed = [];

  for (const track of tracks) {
    try {
      await sendTrackToUser(userId, track, env, { preferUrl: true });
      sent++;
    } catch (err) {
      console.error(`Failed to send ${track.permlink}: ${err.message}`);
      failed.push(track.title || track.permlink);
    }
  }

  let summary = `Done. Sent ${sent}/${tracks.length} songs.`;
  if (failed.length) {
    summary += `\n\nCould not fetch:\n${failed.join("\n")}`;
  }
  await sendMessage(userId, summary, token);
}

async function sendArtistTracksAsLinks(userId, artistName, tracks, env) {
  const token = getBotToken(env);
  const content = buildArtistLinksFile(artistName, tracks);
  const blob = new Blob([content], { type: "text/plain" });
  const fileName = `${artistName}-links.txt`;

  await sendMessage(
    userId,
    `Found ${tracks.length} songs. Sending download links as a file (50+ songs).`,
    token
  );
  await sendDocument(userId, blob, fileName, token);
  await sendMessage(
    userId,
    "Send a single song link if you want one track as audio in chat.",
    token
  );
}

function getFileExtension(sourceUrl) {
  if (sourceUrl?.includes(".m4a")) {
    return "m4a";
  }
  return "mp3";
}

async function sendTrackToUser(userId, track, env, { preferUrl = false } = {}) {
  const token = getBotToken(env);
  const urls = resolveSongUrls(track.mediaType, track.permlink, track.urls);

  if (preferUrl) {
    for (const audioUrl of urls) {
      try {
        await sendAudioByUrl(userId, audioUrl, token);
        return;
      } catch (err) {
        console.warn(`URL send failed for ${audioUrl}: ${err.message}`);
      }
    }
  }

  const { blob, url: sourceUrl } = await fetchFileAsBlob(urls);
  const fileName = `${track.permlink}.${getFileExtension(sourceUrl)}`;
  await sendAudio(userId, blob, fileName, token);
}

async function processUpdate(update, env) {
  const token = getBotToken(env);
  const message = update.message || update.edited_message;

  try {
    if (!token) {
      console.error("BOT_TOKEN not configured");
      return;
    }

    if (!message) {
      return;
    }

    const chatId = message.chat?.id;
    if (!chatId) {
      return;
    }

    const text = message.text?.trim();
    const link = extractLinkFromMessage(message);

    if (text === "/start") {
      await sendMessage(chatId, "Welcome to the bot! 🚀", token);
      return;
    }

    if (link) {
      await handleUrl(chatId, link, env);
      return;
    }

    if (text) {
      await sendMessage(chatId, "Invalid input! Please send a valid Radio Javan link.", token);
    }
  } catch (err) {
    console.error(`processUpdate failed: ${err.message}`);
    const chatId = message?.chat?.id;
    if (chatId && token) {
      try {
        await sendMessage(chatId, `❌ Bot error: ${err.message}`, token);
      } catch (sendErr) {
        console.error(`Failed to send error message: ${sendErr.message}`);
      }
    }
  }
}

async function handleUrl(userId, url, env) {
  try {
    if (url.startsWith("https://rj.app/")) {
      url = await resolveRedirect(url);
      console.log(`Redirected to: ${url}`);
    }

    const { mediaType, mediaName } = parseMediaFromUrl(url);

    if (mediaType === "artist") {
      const artistName = extractArtistName(url);
      await sendMessage(userId, `Fetching songs for ${artistName}...`, getBotToken(env));

      let tracks;
      try {
        tracks = await fetchArtistTracks(env, artistName);
      } catch (err) {
        console.error(`Error fetching artist songs: ${err.message}`);
        await sendMessage(userId, `❌ Error fetching artist songs: ${err.message}`, getBotToken(env));
        return;
      }

      if (tracks.length >= MAX_ARTIST_AUDIO_FILES) {
        await sendArtistTracksAsLinks(userId, artistName, tracks, env);
        return;
      }

      await sendMessage(userId, `Found ${tracks.length} songs. Sending...`, getBotToken(env));
      await sendArtistTracksAsAudio(userId, tracks, env);
      return;
    }

    if (mediaType === "video" || mediaType === "podcast") {
      await sendMessage(userId, "Only song links are supported.", getBotToken(env));
      return;
    }

    if (!isSupportedMediaType(mediaType)) {
      await sendMessage(userId, "Unsupported media type!", getBotToken(env));
      return;
    }

    const { urls, title } = await resolveDownloadUrls(env, mediaType, mediaName);
    if (!urls.length) {
      await sendMessage(userId, "Unsupported media type!", getBotToken(env));
      return;
    }

    const track = {
      permlink: mediaName,
      title,
      mediaType,
      urls,
    };

    try {
      await sendTrackToUser(userId, track, env);
    } catch (err) {
      console.error(`Error sending media: ${err.message}`);
      await sendMessage(
        userId,
        `The file could not be uploaded to Telegram. Download it here: ${urls[0]}`,
        getBotToken(env)
      );
    }
  } catch (err) {
    console.error(`Error in handleUrl: ${err.message}`);
    await sendMessage(
      userId,
      `The file could not be processed. Download it here: ${url}`,
      getBotToken(env)
    );
  }
}

async function resolveRedirect(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": RJ_DEFAULTS.BROWSER_UA,
        Accept: "*/*",
      },
    });

    if (response.ok) {
      console.log(`Resolved URL: ${response.url}`);
      return response.url;
    }

    throw new Error(`Failed to resolve redirect: HTTP ${response.status}`);
  } catch (err) {
    console.error(`Error resolving redirect: ${err.message}`);
    throw new Error("Could not resolve the redirect.");
  }
}

async function sendDocument(chatId, fileBlob, fileName, botToken) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("document", new File([fileBlob], fileName));

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    body: formData,
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Failed to send document: ${result.description}`);
  }
}

async function sendAudioByUrl(chatId, audioUrl, botToken) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendAudio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, audio: audioUrl }),
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Failed to send audio: ${result.description}`);
  }
}

async function sendAudio(chatId, fileBlob, fileName, botToken) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("audio", new File([fileBlob], fileName));

  const apiUrl = `https://api.telegram.org/bot${botToken}/sendAudio`;
  const response = await fetch(apiUrl, {
    method: "POST",
    body: formData,
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Failed to send audio: ${result.description}`);
  }
}

async function sendMessage(chatId, text, botToken) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Failed to send message: ${result.description}`);
  }
}
