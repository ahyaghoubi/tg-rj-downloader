import {
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

export {
  emptyUser,
  getUser,
  putUser,
  isUserBanned,
  touchUser,
  updateUserFlags,
};
