import {
  ADMIN_USER_INDEX_KEY,
  ADMIN_USER_INDEX_LIMIT,
  USER_PROFILE_PREFIX,
  USER_RECENT_PREFIX,
  getJobStore,
  putKv,
  userKey,
  KvWriteLimitError,
} from "../config.js";

function emptyUser(chatId) {
  const now = new Date().toISOString();
  return {
    chatId: String(chatId),
    username: null,
    firstName: null,
    firstSeenAt: now,
    lastSeenAt: now,
    banned: false,
    note: "",
    updatedAt: now,
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
    return {
      ...emptyUser(chatId),
      ...parsed,
      chatId: String(parsed.chatId || chatId),
      banned: Boolean(parsed.banned),
      note: typeof parsed.note === "string" ? parsed.note : "",
    };
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
  const next = {
    ...emptyUser(profile.chatId),
    ...profile,
    chatId: String(profile.chatId),
    banned: Boolean(profile.banned),
    note: typeof profile.note === "string" ? profile.note : "",
    updatedAt: new Date().toISOString(),
  };
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

async function updateUserFlags(env, chatId, { banned, note } = {}) {
  const existing = (await getUser(env, chatId)) || emptyUser(chatId);
  if (typeof banned === "boolean") {
    existing.banned = banned;
  }
  if (typeof note === "string") {
    existing.note = note.slice(0, 500);
  }
  existing.lastSeenAt = existing.lastSeenAt || new Date().toISOString();
  return putUser(env, existing);
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
  touchUser,
  updateUserFlags,
  listKnownUsers,
  rememberUserInIndex,
};
