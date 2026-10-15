import {
  ADMIN_USER_INDEX_KEY,
  ADMIN_USER_INDEX_LIMIT,
  USER_PROFILE_PREFIX,
  USER_RECENT_PREFIX,
  USER_ACTIVITY_LIMIT,
  getJobStore,
  putKv,
  userKey,
  userRecentKey,
  userActivityKey,
  queueChatActiveKey,
  queueChatPendingKey,
  queueChatCancelKey,
  KvWriteLimitError,
  getDefaultDailyDownloadLimit,
  isAdminUser,
} from "../config.js";
import { utcDayKey } from "./stats.js";

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
  const user = {
    ...base,
    ...parsed,
    chatId: String(parsed.chatId || chatId),
    banned: Boolean(parsed.banned),
    vip: Boolean(parsed.vip),
    dailyDownloadLimit:
      parsed.dailyDownloadLimit == null || parsed.dailyDownloadLimit === ""
        ? null
        : Number(parsed.dailyDownloadLimit),
    downloadsToday,
    note: typeof parsed.note === "string" ? parsed.note : "",
  };
  delete user.allowlisted;
  return user;
}

function downloadsTodayCount(user) {
  const day = utcDayKey();
  if (!user?.downloadsToday || user.downloadsToday.day !== day) {
    return 0;
  }
  return Number(user.downloadsToday.count) || 0;
}

function indexEntryFromProfile(profile) {
  const day = utcDayKey();
  const downloadsToday =
    profile?.downloadsToday && profile.downloadsToday.day === day
      ? { day, count: Number(profile.downloadsToday.count) || 0 }
      : { day, count: 0 };
  return {
    chatId: String(profile.chatId),
    username: profile.username || null,
    firstName: profile.firstName || null,
    lastSeenAt: profile.lastSeenAt || new Date().toISOString(),
    banned: Boolean(profile.banned),
    vip: Boolean(profile.vip),
    downloadsToday,
    dailyDownloadLimit:
      profile.dailyDownloadLimit == null || profile.dailyDownloadLimit === ""
        ? null
        : Number(profile.dailyDownloadLimit),
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
    const entry = indexEntryFromProfile(profile);
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
  { banned, note, vip, dailyDownloadLimit } = {}
) {
  const existing = (await getUser(env, chatId)) || emptyUser(chatId);
  if (typeof banned === "boolean") {
    existing.banned = banned;
  }
  if (typeof vip === "boolean") {
    existing.vip = vip;
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
    kv.delete(userActivityKey(id)),
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

function getQuotaSnapshot(env, user) {
  const day = utcDayKey();
  const used = downloadsTodayCount(user);
  const limit = resolveDailyLimit(env, user);
  const unlimited = limit == null;
  return {
    day,
    used,
    limit: unlimited ? null : limit,
    unlimited,
    remaining: unlimited ? null : Math.max(0, limit - used),
  };
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

async function readUserActivity(env, chatId) {
  const kv = getJobStore(env);
  if (!kv || chatId == null) {
    return [];
  }
  try {
    const raw = await kv.get(userActivityKey(chatId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function recordUserActivity(env, chatId, { type, detail = null } = {}) {
  const kv = getJobStore(env);
  if (!kv || chatId == null || !type) {
    return;
  }
  try {
    const existing = await readUserActivity(env, chatId);
    const event = {
      type: String(type),
      detail: detail == null ? null : String(detail).slice(0, 200),
      at: new Date().toISOString(),
    };
    const next = [event, ...existing].slice(0, USER_ACTIVITY_LIMIT);
    await putKv(kv, userActivityKey(chatId), JSON.stringify(next), {
      expirationTtl: 90 * 24 * 60 * 60,
    });
  } catch (err) {
    if (!(err instanceof KvWriteLimitError)) {
      console.warn(`recordUserActivity failed for ${chatId}: ${err.message}`);
    }
  }
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

function listEntryFromUser(user, source) {
  return {
    chatId: String(user.chatId),
    username: user.username || null,
    firstName: user.firstName || null,
    lastSeenAt: user.lastSeenAt || null,
    banned: Boolean(user.banned),
    vip: Boolean(user.vip),
    downloadsToday: {
      day: user.downloadsToday?.day || utcDayKey(),
      count: downloadsTodayCount(user),
    },
    dailyDownloadLimit:
      user.dailyDownloadLimit == null ? null : Number(user.dailyDownloadLimit),
    note: user.note || "",
    source,
    hasProfile: source !== "recents",
    isAdmin: false,
  };
}

async function listKnownUsers(
  env,
  {
    q = "",
    filter = "all",
    sort = "lastSeen",
    offset = 0,
    limit = 25,
    bannedOnly = false,
  } = {}
) {
  const kv = getJobStore(env);
  const pageLimit = Math.min(Math.max(1, Number(limit) || 25), 100);
  const pageOffset = Math.max(0, Number(offset) || 0);
  if (!kv) {
    return { users: [], total: 0, offset: pageOffset, limit: pageLimit };
  }

  const byId = new Map();
  const day = utcDayKey();

  try {
    const indexRaw = await kv.get(ADMIN_USER_INDEX_KEY);
    if (indexRaw) {
      const index = JSON.parse(indexRaw);
      if (Array.isArray(index)) {
        for (const item of index) {
          if (!item?.chatId) {
            continue;
          }
          const downloadsToday =
            item.downloadsToday && item.downloadsToday.day === day
              ? { day, count: Number(item.downloadsToday.count) || 0 }
              : { day, count: 0 };
          byId.set(String(item.chatId), {
            chatId: String(item.chatId),
            username: item.username || null,
            firstName: item.firstName || null,
            lastSeenAt: item.lastSeenAt || null,
            banned: Boolean(item.banned),
            vip: Boolean(item.vip),
            downloadsToday,
            dailyDownloadLimit:
              item.dailyDownloadLimit == null || item.dailyDownloadLimit === ""
                ? null
                : Number(item.dailyDownloadLimit),
            source: "index",
            hasProfile: true,
            isAdmin: false,
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
      byId.set(chatId, listEntryFromUser(user, "profile"));
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
        vip: false,
        downloadsToday: { day, count: 0 },
        dailyDownloadLimit: null,
        source: "recents",
        hasProfile: false,
        isAdmin: false,
      });
    }
  } catch (err) {
    console.warn(`listKnownUsers recents scan failed: ${err.message}`);
  }

  let users = [...byId.values()].map((user) => ({
    ...user,
    isAdmin: isAdminUser(env, user.chatId),
    downloadsToday: {
      day: user.downloadsToday?.day || day,
      count:
        user.downloadsToday?.day === day ? Number(user.downloadsToday.count) || 0 : 0,
    },
  }));

  const query = String(q || "")
    .trim()
    .toLowerCase();
  if (query) {
    users = users.filter((user) => {
      const hay = [
        user.chatId,
        user.username || "",
        user.firstName || "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(query);
    });
  }

  let effectiveFilter = String(filter || "all").toLowerCase();
  if (bannedOnly) {
    effectiveFilter = "banned";
  }
  if (effectiveFilter === "vip") {
    users = users.filter((user) => user.vip);
  } else if (effectiveFilter === "banned") {
    users = users.filter((user) => user.banned);
  } else if (effectiveFilter === "normal") {
    users = users.filter((user) => !user.vip && !user.banned && !user.isAdmin);
  } else if (effectiveFilter === "admin") {
    users = users.filter((user) => user.isAdmin);
  }

  if (sort === "downloads") {
    users.sort((a, b) => {
      const diff = (b.downloadsToday?.count || 0) - (a.downloadsToday?.count || 0);
      if (diff !== 0) {
        return diff;
      }
      return String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""));
    });
  } else {
    users.sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
  }

  const total = users.length;
  return {
    users: users.slice(pageOffset, pageOffset + pageLimit),
    total,
    offset: pageOffset,
    limit: pageLimit,
  };
}

export {
  emptyUser,
  getUser,
  putUser,
  isUserBanned,
  touchUser,
  updateUserFlags,
  clearUserRecents,
  wipeUser,
  listKnownUsers,
  rememberUserInIndex,
  resolveDailyLimit,
  getQuotaSnapshot,
  checkAndConsumeQuota,
  readUserActivity,
  recordUserActivity,
};
