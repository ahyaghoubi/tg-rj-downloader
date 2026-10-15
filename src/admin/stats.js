import {
  ADMIN_STATS_PREFIX,
  getJobStore,
  putKv,
  KvWriteLimitError,
} from "../config.js";

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function statsKey(day = utcDayKey()) {
  return `${ADMIN_STATS_PREFIX}:${day}`;
}

function emptyStats(day) {
  return {
    day,
    songs: 0,
    artists: 0,
    playlists: 0,
    albums: 0,
    searches: 0,
    inline: 0,
    messages: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function readDailyStats(env, day = utcDayKey()) {
  const kv = getJobStore(env);
  if (!kv) {
    return emptyStats(day);
  }
  try {
    const raw = await kv.get(statsKey(day));
    if (!raw) {
      return emptyStats(day);
    }
    return { ...emptyStats(day), ...JSON.parse(raw), day };
  } catch {
    return emptyStats(day);
  }
}

async function incrementStat(env, field, amount = 1) {
  const kv = getJobStore(env);
  if (!kv || !field) {
    return;
  }
  const day = utcDayKey();
  try {
    const current = await readDailyStats(env, day);
    current[field] = Number(current[field] || 0) + amount;
    current.updatedAt = new Date().toISOString();
    await putKv(kv, statsKey(day), JSON.stringify(current), {
      expirationTtl: 40 * 24 * 60 * 60,
    });
  } catch (err) {
    if (!(err instanceof KvWriteLimitError)) {
      console.warn(`incrementStat(${field}) failed: ${err.message}`);
    }
  }
}

async function readRecentDailyStats(env, days = 7) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const day = utcDayKey(new Date(now - i * 24 * 60 * 60 * 1000));
    out.push(await readDailyStats(env, day));
  }
  return out;
}

export {
  utcDayKey,
  statsKey,
  emptyStats,
  readDailyStats,
  incrementStat,
  readRecentDailyStats,
};
