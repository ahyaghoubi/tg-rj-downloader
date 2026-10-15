import {
  ADMIN_USER_INDEX_KEY,
  ADMIN_USER_INDEX_LIMIT,
  USER_PROFILE_PREFIX,
  USER_RECENT_PREFIX,
  getJobStore,
  putKv,
  userKey,
  userRecentKey,
  queueChatActiveKey,
  queueChatPendingKey,
  queueChatCancelKey,
  KvWriteLimitError,
  getDefaultDailyDownloadLimit,
  isAdminUser,
} from "../config.js";
import { utcDayKey } from "./stats.js";
import { isAllowlistMode } from "./runtime-config.js";

function emptyUser(chatId) {
  const now = new Date().toISOString();
  return {
    chatId: String(chatId),
    username: null,
    firstName: null,
    firstSeenAt: now,
    lastSeenAt: now,
    banned: false,
    vip: false,
    allowlisted: false,
    dailyDownloadLimit: null,
    downloadsToday: { day: utcDayKey(), count: 0 },
    note: "",
    updatedAt: now,
  };
}

function normalizeUser(chatId, parsed = {}) {
  const base = emptyUser(chatId);
  const downloadsToday =
    parsed.downloadsToday && typeof parsed.downloadsToday === "object"
      ? {
          day: parsed.downloadsToday.day || utcDayKey(),
          count: Number(parsed.downloadsToday.count) || 0,
        }
      : base.downloadsToday;
  return {
    ...base,
    ...parsed,
    chatId: String(parsed.chatId || chatId),
    banned: Boolean(parsed.banned),
    vip: Boolean(parsed.vip),
    allowlisted: Boolean(parsed.allowlisted),
    dailyDownloadLimit:
      parsed.dailyDownloadLimit == null || parsed.dailyDownloadLimit === ""
        ? null
        : Number(parsed.dailyDownloadLimit),
    downloadsToday,
    note: typeof parsed.note === "string" ? parsed.note : "",
  };
}

async function getUser(env, chatId) {
  const kv = getJobStore(env);
  if (!kv || chatId == null || chatId === "") {
    return null;
  }
  try {
    const raw = await kv.get(userKey(chatId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return normalizeUser(chatId, parsed);
  } catch (err) {
    console.warn(`getUser failed for ${chatId}: ${err.message}`);
    return null;
  }
}

async function rememberUserInIndex(env, profile) {
  const kv = getJobStore(env);
  if (!kv || !profile?.chatId) {
    return;
  }
  try {
    const raw = await kv.get(ADMIN_USER_INDEX_KEY);
    let list = [];
    if (raw) {
      const parsed = JSON.parse(raw);
      list = Array.isArray(parsed) ? parsed : [];
    }
    const entry = {
      chatId: String(profile.chatId),
      username: profile.username || null,
      firstName: profile.firstName || null,
      lastSeenAt: profile.lastSeenAt || new Date().toISOString(),
      banned: Boolean(profile.banned),
      vip: Boolean(profile.vip),
      allowlisted: Boolean(profile.allowlisted),
    };
    list = [entry, ...list.filter((item) => String(item.chatId) !== entry.chatId)].slice(
      0,
      ADMIN_USER_INDEX_LIMIT
    );
    await putKv(kv, ADMIN_USER_INDEX_KEY, JSON.stringify(list), {
      expirationTtl: 180 * 24 * 60 * 60,
    });
  } catch (err) {
    if (!(err instanceof KvWriteLimitError)) {
      console.warn(`rememberUserInIndex failed: ${err.message}`);
    }
  }
}

async function putUser(env, profile) {
  const kv = getJobStore(env);
  if (!kv || !profile?.chatId) {
    return null;
  }
  const next = normalizeUser(profile.chatId, {
    ...profile,
    updatedAt: new Date().toISOString(),
  });
  await putKv(kv, userKey(next.chatId), JSON.stringify(next));
  await rememberUserInIndex(env, next);
  return next;
}

async function isUserBanned(env, chatId) {
  const user = await getUser(env, chatId);
  return Boolean(user?.banned);
}

/**
 * When allowlist mode is on, only allowlisted chats and bot admins may use the bot.
 * VIP is unrelated — it only affects download quota.
 */
async function isUserAllowed(env, chatId) {
  if (chatId == null || chatId === "") {
    return false;
  }
  if (isAdminUser(env, chatId)) {
    return true;
  }
  if (!isAllowlistMode(env)) {
    return true;
  }
  const user = await getUser(env, chatId);
  return Boolean(user?.allowlisted);
}

async function touchUser(env, from, chat = null) {
  const chatId = chat?.id ?? from?.id;
  if (chatId == null) {
    return null;
  }

  try {
    const existing = await getUser(env, chatId);
    const now = new Date().toISOString();
    const next = {
      ...(existing || emptyUser(chatId)),
      chatId: String(chatId),
      username: from?.username || existing?.username || null,
      firstName: from?.first_name || existing?.firstName || null,
      lastSeenAt: now,
      firstSeenAt: existing?.firstSeenAt || now,
      banned: Boolean(existing?.banned),
      vip: Boolean(existing?.vip),
      allowlisted: Boolean(existing?.allowlisted),
      dailyDownloadLimit: existing?.dailyDownloadLimit ?? null,
      downloadsToday: existing?.downloadsToday || { day: utcDayKey(), count: 0 },
      note: existing?.note || "",
      updatedAt: now,
    };
    return await putUser(env, next);
  } catch (err) {
    if (!(err instanceof KvWriteLimitError)) {
      console.warn(`touchUser failed for ${chatId}: ${err.message}`);
    }
    return null;
  }
}

async function updateUserFlags(
  env,
  chatId,
  { banned, note, vip, allowlisted, dailyDownloadLimit } = {}
) {
  const existing = (await getUser(env, chatId)) || emptyUser(chatId);
  if (typeof banned === "boolean") {
    existing.banned = banned;
  }
  if (typeof vip === "boolean") {
    existing.vip = vip;
  }
  if (typeof allowlisted === "boolean") {
    existing.allowlisted = allowlisted;
  }
  if (typeof note === "string") {
    existing.note = note.slice(0, 500);
  }
  if (dailyDownloadLimit === null || dailyDownloadLimit === "") {
    existing.dailyDownloadLimit = null;
  } else if (dailyDownloadLimit != null && Number.isFinite(Number(dailyDownloadLimit))) {
    existing.dailyDownloadLimit = Math.max(0, Number(dailyDownloadLimit));
  }
  existing.lastSeenAt = existing.lastSeenAt || new Date().toISOString();
  return putUser(env, existing);
}

async function clearUserRecents(env, chatId) {
  const kv = getJobStore(env);
  if (!kv || chatId == null) {
    return { ok: false, error: "missing store or chatId" };
  }
  await kv.delete(userRecentKey(chatId));
  return { ok: true, chatId: String(chatId), cleared: "recents" };
}

async function wipeUser(env, chatId) {
  const kv = getJobStore(env);
  if (!kv || chatId == null) {
    return { ok: false, error: "missing store or chatId" };
  }
  const id = String(chatId);
  await Promise.all([
    kv.delete(userKey(id)),
    kv.delete(userRecentKey(id)),
    kv.delete(queueChatActiveKey(id)),
    kv.delete(queueChatPendingKey(id)),
    kv.delete(queueChatCancelKey(id)),
  ]);
  try {
    const raw = await kv.get(ADMIN_USER_INDEX_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        const next = list.filter((item) => String(item.chatId) !== id);
        await putKv(kv, ADMIN_USER_INDEX_KEY, JSON.stringify(next), {
          expirationTtl: 180 * 24 * 60 * 60,
        });
      }
    }
  } catch (err) {
    if (!(err instanceof KvWriteLimitError)) {
      console.warn(`wipeUser index cleanup failed: ${err.message}`);
    }
  }
  return { ok: true, chatId: id, wiped: true };
}

function resolveDailyLimit(env, user) {
  // Separate paths to unlimited: VIP flag, or bot admin (ADMIN_USER_IDS).
  // Admin is not treated as VIP — both simply skip the daily cap.
  if (user?.vip || isAdminUser(env, user?.chatId)) {
    return null;
  }
  if (user?.dailyDownloadLimit != null && Number.isFinite(Number(user.dailyDownloadLimit))) {
    return Number(user.dailyDownloadLimit);
  }
  return getDefaultDailyDownloadLimit(env);
}

/**
 * Reserve `amount` downloads against the user's daily quota.
 * Returns { ok, remaining, limit, used, user } — ok=false when over quota.
 */
async function checkAndConsumeQuota(env, chatId, amount = 1) {
  const needed = Math.max(1, Number(amount) || 1);
  let user = (await getUser(env, chatId)) || emptyUser(chatId);
  const day = utcDayKey();
  if (!user.downloadsToday || user.downloadsToday.day !== day) {
    user.downloadsToday = { day, count: 0 };
  }
  const limit = resolveDailyLimit(env, user);
  if (limit == null) {
    user.downloadsToday.count += needed;
    try {
      user = (await putUser(env, user)) || user;
    } catch (_) {
      // best effort
    }
    return { ok: true, unlimited: true, remaining: null, limit: null, used: user.downloadsToday.count, user };
  }
  if (user.downloadsToday.count + needed > limit) {
    return {
      ok: false,
      unlimited: false,
      remaining: Math.max(0, limit - user.downloadsToday.count),
      limit,
      used: user.downloadsToday.count,
      user,
    };
  }
  user.downloadsToday.count += needed;
  try {
    user = (await putUser(env, user)) || user;
  } catch (_) {
    // best effort
  }
  return {
    ok: true,
    unlimited: false,
    remaining: Math.max(0, limit - user.downloadsToday.count),
    limit,
    used: user.downloadsToday.count,
    user,
  };
}

async function listKvKeys(kv, prefix, limit = 200) {
  if (!kv?.list) {
    return [];
  }
  const names = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, limit: Math.min(100, limit - names.length), cursor });
    for (const key of page.keys || []) {
      names.push(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && names.length < limit);
  return names;
}

async function listKnownUsers(env, { limit = 50, bannedOnly = false } = {}) {
  const kv = getJobStore(env);
  if (!kv) {
    return [];
  }

  const byId = new Map();

  try {
    const indexRaw = await kv.get(ADMIN_USER_INDEX_KEY);
    if (indexRaw) {
      const index = JSON.parse(indexRaw);
      if (Array.isArray(index)) {
        for (const item of index) {
          if (!item?.chatId) {
            continue;
          }
          byId.set(String(item.chatId), {
            chatId: String(item.chatId),
            username: item.username || null,
            firstName: item.firstName || null,
            lastSeenAt: item.lastSeenAt || null,
            banned: Boolean(item.banned),
            vip: Boolean(item.vip),
            allowlisted: Boolean(item.allowlisted),
            source: "index",
            hasProfile: true,
          });
        }
      }
    }
  } catch (err) {
    console.warn(`listKnownUsers index read failed: ${err.message}`);
  }

  try {
    const profileKeys = await listKvKeys(kv, `${USER_PROFILE_PREFIX}:`, 200);
    for (const key of profileKeys) {
      const chatId = key.slice(`${USER_PROFILE_PREFIX}:`.length);
      if (!chatId) {
        continue;
      }
      const user = await getUser(env, chatId);
      if (!user) {
        continue;
      }
      byId.set(chatId, {
        chatId,
        username: user.username,
        firstName: user.firstName,
        lastSeenAt: user.lastSeenAt,
        banned: user.banned,
        vip: user.vip,
        allowlisted: user.allowlisted,
        note: user.note || "",
        source: "profile",
        hasProfile: true,
      });
    }
  } catch (err) {
    console.warn(`listKnownUsers profile scan failed: ${err.message}`);
  }

  try {
    const recentKeys = await listKvKeys(kv, `${USER_RECENT_PREFIX}:`, 200);
    for (const key of recentKeys) {
      const chatId = key.slice(`${USER_RECENT_PREFIX}:`.length);
      if (!chatId || byId.has(chatId)) {
        continue;
      }
      byId.set(chatId, {
        chatId,
        username: null,
        firstName: null,
        lastSeenAt: null,
        banned: false,
        source: "recents",
        hasProfile: false,
      });
    }
  } catch (err) {
    console.warn(`listKnownUsers recents scan failed: ${err.message}`);
  }

  let users = [...byId.values()];
  if (bannedOnly) {
    users = users.filter((user) => user.banned);
  }
  users.sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
  return users.slice(0, limit);
}

export {
  emptyUser,
  getUser,
  putUser,
  isUserBanned,
  isUserAllowed,
  touchUser,
  updateUserFlags,
  clearUserRecents,
  wipeUser,
  listKnownUsers,
  rememberUserInIndex,
  resolveDailyLimit,
  checkAndConsumeQuota,
};
