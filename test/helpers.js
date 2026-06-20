import assert from "node:assert/strict";

export function createMockKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const operations = [];

  return {
    store,
    operations,
    async get(key) {
      operations.push({ type: "get", key });
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      operations.push({ type: "put", key, value, options });
      store.set(key, value);
    },
    async delete(key) {
      operations.push({ type: "delete", key });
      store.delete(key);
    },
  };
}

export function createFailingPutKv(message = "Daily Workers KV put limit exceeded") {
  const kv = createMockKv();
  kv.put = async (key, value, options) => {
    kv.operations.push({ type: "put", key, value, options });
    throw new Error(message);
  };
  return kv;
}

export function createMockQueue() {
  const messages = [];
  return {
    messages,
    async send(payload, options = {}) {
      messages.push({ payload: structuredClone(payload), options });
    },
  };
}

export function createMockCtx() {
  const promises = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(promise);
    },
    async flush() {
      await Promise.allSettled(promises);
    },
  };
}

export function createQueueBatch(bodies) {
  return {
    messages: bodies.map((body) => {
      const record = {
        body,
        acked: false,
        retried: false,
        retryOptions: undefined,
        ack() {
          record.acked = true;
        },
        retry(options) {
          record.retried = true;
          record.retryOptions = options;
        },
      };
      return record;
    }),
  };
}

export function createEnv(overrides = {}) {
  const artistQueue = createMockQueue();
  return {
    BOT_TOKEN: "test-token",
    ARTIST_DELIVERY_MODE: "queue",
    ARTIST_QUEUE_DELAY_SECONDS: "2",
    ENABLE_BULK_CACHE_WRITES: "false",
    ARTIST_QUEUE: artistQueue,
    TELEGRAM_FILE_CACHE: createMockKv(),
    ARTIST_JOB_STORE: createMockKv(),
    queueMessages: artistQueue.messages,
    ...overrides,
  };
}

export function mockFetch(handler) {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls);
  };

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

export function mockTelegramFetch({ ok = true, retryAfter = 0, fileId = "telegram-file-id" } = {}) {
  return mockFetch(({ url, init }) => {
    assert.match(url, /^https:\/\/api\.telegram\.org\/bot/);

    if (!ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          description: retryAfter ? "Too Many Requests" : "Telegram error",
          parameters: retryAfter ? { retry_after: retryAfter } : undefined,
        }),
        { status: retryAfter ? 429 : 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const method = url.split("/").pop();
    const result =
      method === "sendMessage"
        ? { message_id: 1, text: init.body }
        : { audio: { file_id: fileId } };

    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

export function mockRadioJavanAndTelegramFetch({ artistPayload, telegramOk = true } = {}) {
  return mockFetch(({ url }) => {
    if (url.startsWith("https://api.telegram.org/")) {
      return new Response(
        JSON.stringify({
          ok: telegramOk,
          result: telegramOk ? { audio: { file_id: "telegram-file-id" } } : undefined,
          description: telegramOk ? undefined : "Telegram error",
        }),
        {
          status: telegramOk ? 200 : 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.startsWith("https://play.radiojavan.com/api/")) {
      return new Response(JSON.stringify(artistPayload ?? { songs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("", { status: 404 });
  });
}

export function makeTrack(permlink, extra = {}) {
  return {
    permlink,
    title: extra.title || permlink,
    mediaType: extra.mediaType || "song",
    urls: extra.urls || [`https://host2.rj-mw1.com/media/mp3/mp3-320/${permlink}.mp3`],
    ...extra,
  };
}
