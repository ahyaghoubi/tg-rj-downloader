# Radio Javan Telegram Bot

A Cloudflare Worker script that turns your Telegram bot into a Radio Javan media downloader. Users simply send a Radio Javan song link to the bot and receive the audio file directly in Telegram.

---

## Features

- **Telegram Webhook Integration**  
  Listens for updates on the `/webhook` route and processes commands, search, inline queries, callback buttons, or media links.
  - `/search <query>`, plain-text search, and inline mode (`@bot query`) with tap-to-download buttons
  - `/help`, `/recent`, `/cancel`, and admin `/status`
  - Progress updates during artist delivery and clearer duplicate-delivery messages

- **Media Processing**  
  - Automatically resolves shortened URLs (e.g., `https://rj.app/`).
  - Determines media type (song or artist) and fetches the appropriate audio file.
  - Skips videos and podcasts on artist pages and rejects direct video/podcast links.
  - Prefers direct download URLs returned by the Radio Javan API (`link`, `hq_link`, `lq_link`).
  - Falls back to a small set of preferred CDN hosts when API links are unavailable.
  - Prefers Telegram URL delivery first for single songs, then downloads/uploads only if needed.
  - Skips CDN hosts that Telegram rejects for URL fetch within the same send attempt.
  - Always prefers 320 kbps audio and falls back to 256 kbps only when 320 kbps is unavailable.

- **Telegram Upload Cache** _(optional, recommended)_  
  - Reuses Telegram's `file_id` for songs that were already uploaded, so repeated requests are resent instead of re-downloaded and re-uploaded.
  - Cache entries are keyed by lowercase permlink **and** quality, so casing variants (`Ebi-X` / `ebi-x`) share one entry. Legacy mixed-case keys are migrated on read.
  - Large artist deliveries **read** existing cached `file_id`s but do not write new cache records (protects the free Workers KV daily write limit ~1,000/day). Single-song sends and warm jobs still write cache.
  - Use `POST /internal/warm-artist` to send **only uncached** songs for an artist and write those into the cache intentionally.
  - Do **not** try to cache the entire Radio Javan catalog on the free tier.
  - Invalid cached IDs are removed automatically and the song is re-uploaded.

- **Queue-Only Artist Delivery** _(required for artist links)_  
  - Sends long artist catalogs through Cloudflare Queues, one song per queue message.
  - Each queue message enqueues the next one until every song is sent, avoiding per-song KV progress writes.
  - Serializes Queue deliveries per Telegram chat so a second artist waits instead of interleaving songs.
  - Routes messages that exhaust retries to a Dead Letter Queue and notifies the chat.
  - Handles Telegram `429` rate limits by reading `retry_after` and resuming later.

- **Future-Proof Resolution**  
  - Uses `/api/p/mp3` and `/api/p/artist` metadata endpoints first.
  - Tries alternate artist API versions if the primary request fails.
  - Validates candidate URLs with HTTP `HEAD` before downloading.
  - Supports optional `RJ_API_KEY` and `RJ_USER_AGENT` environment variables for credential rotation without code changes.

- **File Delivery**  
  - Sends audio files via the Telegram [`sendAudio`](https://core.telegram.org/bots/api#sendaudio) API.
  - Reuses cached Telegram `file_id`s when available to skip re-downloading and re-uploading.
  - Provides fallback download links if an upload fails.

- **Robust Error Handling**  
  Provides user-friendly error messages for unsupported media types or file upload issues.

---

## How It Works

1. **Webhook Handling**  
   The worker intercepts POST requests at `/webhook` from Telegram and processes incoming updates. It recognizes commands (like `/start`) and media links, triggering file processing.

2. **Media URL Resolution**  
   For URLs starting with `https://rj.app/`, the worker resolves any redirections to obtain the full media URL.

3. **Fetching Media**  
   The worker resolves media in layers:
   1. **API metadata** — fetches track info from Radio Javan (`/api/p/mp3?id=...`, `/api/p/artist?query=...`, etc.) and uses the direct `link` fields when present. Video and podcast entries are skipped.
   2. **Constructed fallbacks** — if needed, tries `mp3-320` then `mp3-256` on a couple of preferred CDN hosts (with limited permlink casing). API `mp3-256` links are also upgraded to `mp3-320` when that file exists.
   3. **Fast delivery** — Telegram URL send is tried first; Worker-side download/upload is a short fallback with timeouts and a capped attempt count.

   Artist pages use the Radio Javan API with `x-api-key`, `x-rj-user-agent`, `Referer`, and `Origin` headers.

4. **Sending Media to Telegram**  
   For each quality (320 kbps first, then 256 kbps), the worker:
   1. Checks the `TELEGRAM_FILE_CACHE` KV namespace for a reusable `file_id` and resends it if present.
   2. Otherwise asks Telegram to fetch a direct audio URL (`preferUrl`), skipping hosts Telegram already rejected.
   3. If URL send fails, downloads a small number of candidates in the Worker and uploads the blob, then stores the returned `file_id` for next time.

   When a file cannot be uploaded, a fallback download link is sent to the user. Cached `file_id`s are reusable only by the same bot that uploaded them.

5. **Artist Delivery (Queue-Backed Continuation)**  
   When `ARTIST_QUEUE` is configured, artist links are delivered through Cloudflare Queues:

   - The first queue message contains the full track list and starts at `nextIndex: 0`.
   - Each queue message sends one song, updates the in-message progress, and enqueues the next message.
   - Queue messages store compact track metadata (`permlink`, title, and media type) so large artists stay under Queue message-size limits.
   - Per-chat Queue locks prevent a second artist for the same chat from interleaving until the current delivery finishes (or lands in the DLQ).
   - Queue delivery is also globally serialized (`max_concurrency = 1`) and delayed between songs by default.
   - Exhausted retries go to `telegram-radiojavan-artist-delivery-dlq`, which notifies the chat and promotes any pending request.
   - Artist deliveries read from `TELEGRAM_FILE_CACHE`, but bulk artist cache writes are disabled by default to protect the free KV write quota.
   - `ARTIST_JOB_STORE` holds per-chat queue locks, cancel flags, recents, and long callback payloads (not legacy job documents).

   Artist links require the `ARTIST_QUEUE` binding. Without it, the bot reports a configuration error instead of falling back to a sync album send.

---

## Setup Instructions

### Prerequisites

- **Telegram Bot Token**  
  You can obtain a token by messaging [BotFather](https://core.telegram.org/bots#botfather) on Telegram.

- **Cloudflare Account**  
  Ensure you have an account and the necessary permissions to deploy Cloudflare Workers.

### Deployment

1. **Clone the Repository**

   ```sh
   git clone https://github.com/ahyaghoubi/tg-rj-downloader.git
   cd your-repo
   ```

2. **Configure the Cloudflare Worker**

   - Log in to your [Cloudflare dashboard](https://dash.cloudflare.com/).
   - Navigate to **Workers** and create a new Worker.
   - Deploy with Wrangler (`main = "src/index.js"` in `wrangler.toml`).
   - Set up environment variables and secrets:
     - `BOT_TOKEN` — your Telegram Bot Token (**required**, set as a Worker secret or variable)
     - `JOB_RUNNER_SECRET` — shared secret that protects `POST /internal/warm-artist` (**required for cache warm**)
     - `ADMIN_TOKEN` — password for the `/admin` dashboard (**required for admin UI**)
     - `DEFAULT_DAILY_DOWNLOAD_LIMIT` — optional daily download cap per non-VIP / non-admin user (default `80`; overridable in `/admin` runtime settings)
     - `RJ_API_KEY` — Radio Javan API key (optional; defaults built in)
     - `RJ_USER_AGENT` — Radio Javan client user agent (optional; defaults built in)
   - Create and bind the KV namespaces and Queue (see [Cloudflare Bindings](#cloudflare-bindings)):
     - `TELEGRAM_FILE_CACHE` — optional but recommended; enables `file_id` reuse.
     - `ARTIST_JOB_STORE` — queue chat locks, cancel flags, recents, callbacks.
     - `ARTIST_QUEUE` — **required** for artist catalog delivery.

   After deploying, open `https://<your-worker>.workers.dev/health` in a browser. You should see JSON with `"ok":true`, the bot username, queue/DLQ names, and ops hints.

   If you see `BOT_TOKEN not configured` or `"ok":false`, fix the token in Cloudflare **Settings → Variables**.

3. **Set the Telegram Webhook**

   Use the following command (replace `<BOT_TOKEN>` and `<your-worker-subdomain>` with your actual Bot Token and Cloudflare Worker subdomain):

   ```sh
   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" -d "url=https://<your-worker-subdomain>.workers.dev/webhook"
   ```

4. **Testing the Bot**

   - Start a conversation with your bot on Telegram.
   - Send the `/start` command to receive a welcome message.
   - Send a Radio Javan media link (e.g., `https://rj.app/example`) to trigger media processing and delivery.
   - Send an artist page link (e.g., `https://play.radiojavan.com/artist/chaartaar`) to fetch and send all available songs.

5. **Verify the Webhook**

   Check that Telegram is pointing at your deployed worker:

   ```sh
   curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
   ```

   The `url` must match `https://<your-worker-subdomain>.workers.dev/webhook`. Also confirm `BOT_TOKEN` is set in the worker environment variables.

---

## Cloudflare Bindings

Artist delivery uses [Cloudflare Queues](https://developers.cloudflare.com/queues/) plus [Cloudflare KV](https://developers.cloudflare.com/kv/) for chat locks and Telegram `file_id` cache. There is no legacy KV job / self-call fallback.

1. **Create the KV namespaces and Queue**

   ```sh
   npx wrangler kv namespace create TELEGRAM_FILE_CACHE
   npx wrangler kv namespace create ARTIST_JOB_STORE
   npx wrangler queues create telegram-radiojavan-artist-delivery
   # DLQ is created automatically on deploy when referenced, or create it explicitly:
   npx wrangler queues create telegram-radiojavan-artist-delivery-dlq
   ```

2. **Add the bindings to `wrangler.toml`** (paste the KV IDs returned above)

   ```toml
   main = "src/index.js"

   [[kv_namespaces]]
   binding = "TELEGRAM_FILE_CACHE"
   id = "<production-kv-namespace-id>"

   [[kv_namespaces]]
   binding = "ARTIST_JOB_STORE"
   id = "<production-artist-job-kv-namespace-id>"

   [[queues.producers]]
   binding = "ARTIST_QUEUE"
   queue = "telegram-radiojavan-artist-delivery"

   [[queues.consumers]]
   queue = "telegram-radiojavan-artist-delivery"
   max_batch_size = 1
   max_batch_timeout = 1
   max_retries = 3
   max_concurrency = 1
   dead_letter_queue = "telegram-radiojavan-artist-delivery-dlq"

   [[queues.consumers]]
   queue = "telegram-radiojavan-artist-delivery-dlq"
   max_batch_size = 1
   max_batch_timeout = 1
   max_retries = 1
   max_concurrency = 1

   [vars]
   ARTIST_QUEUE_DELAY_SECONDS = "1"
   MAX_AUDIO_URL_ATTEMPTS = "3"
   ARTIST_PROGRESS_EVERY = "5"
   ```

3. **Set secrets**

   ```sh
   npx wrangler secret put BOT_TOKEN
   npx wrangler secret put JOB_RUNNER_SECRET
   npx wrangler secret put ADMIN_TOKEN
   ```

   Open the ops dashboard at `https://<your-worker>.workers.dev/admin` and sign in with `ADMIN_TOKEN`.

   Runtime controls on `/admin` (KV, no redeploy): queue pause, safe numeric overrides (queue delay, progress every, daily limit). Users console supports search/filters/pagination, VIP/ban/quota/note, activity history, and messaging.

**Notes**

- `TELEGRAM_FILE_CACHE` reuse only works for the same bot that uploaded the file. Cache entries are quality-specific (`320` vs `256`) and keyed by lowercase permlink.
- `max_concurrency = 1` and `ARTIST_QUEUE_DELAY_SECONDS=1` (base gap) are recommended. Delay is adaptive: it rises after Telegram `429` and decays back toward the base after clean sends. Use `0` for maximum speed when traffic is light.
- Per-chat Queue locks use a couple of short-lived `ARTIST_JOB_STORE` keys so concurrent artist requests for one chat do not interleave.
- Configure `dead_letter_queue` so stalled artist messages remain inspectable and the chat is notified instead of silently dropping.
- Inspect queue/DLQ consumers with `bash scripts/check-dlq.sh` and watch live logs with `npx wrangler tail`.
- Artist deliveries read existing cached `file_id`s but do not write new bulk cache entries. Single-song and warm-artist paths still write cache.
- To warm only missing songs for one artist (and write cache for those), call `POST /internal/warm-artist` with `JOB_RUNNER_SECRET`. Stay within ~1,000 KV writes/day.

Do not bulk-delete `TELEGRAM_FILE_CACHE` unless you intentionally want songs to be uploaded again.

---

## Troubleshooting

- **Bot does not respond** — Check `getWebhookInfo` points to `/webhook` on your worker, and that `BOT_TOKEN` is set in Cloudflare **Settings → Variables**. The worker returns `200 OK` immediately and processes updates in the background via `ctx.waitUntil`.
- **Artist delivery stops partway** — Confirm `ARTIST_QUEUE` is configured and the Queue consumer is deployed. Run `bash scripts/check-dlq.sh` and watch `wrangler tail` for `Artist delivery DLQ` messages.
- **Artist delivery never starts** — Confirm the `ARTIST_QUEUE` binding and Wrangler deployment output for Queue consumer errors.
- **Songs re-upload every time** — Bind `TELEGRAM_FILE_CACHE` so the bot can store and reuse Telegram `file_id`s. Keys are lowercase; legacy casing duplicates are migrated on read.
- **Daily Workers KV put limit exceeded** — Queue mode avoids per-song KV progress writes. Normal artist sends do not write bulk cache entries. Use `/internal/warm-artist` only for shortlists. Single-song / warm cache writes may fail until Cloudflare resets the daily quota (~1,000 puts/day on free).
- **403 on artist API** — Ensure `RJ_API_KEY` and `RJ_USER_AGENT` are set, or redeploy with the built-in defaults.

---

## Testing

Run the local test suite with:

```sh
npm test
```

Run a syntax-only Worker check with:

```sh
npm run check
```

The test suite is local-only: it uses mocked Telegram, Radio Javan, Cloudflare KV, Cloudflare Queues, and Worker `ctx.waitUntil` helpers. It does not send real bot messages or call Cloudflare.

Current coverage includes:

- URL normalization, Telegram message link extraction, media parsing, and 320/256 URL ordering.
- Radio Javan artist payload extraction, duplicate removal, and video/podcast filtering.
- Telegram `file_id` cache hits, lowercase cache keys with legacy migration, rejected cache cleanup, upload caching, artist deliveries that skip bulk cache writes, dead-host skipping, uncached-track filtering, and KV quota handling.
- Queue artist delivery payload compaction, one-song continuation, delayed requeueing, completion summaries, failed-track continuation, duplicate skips, retry behavior, per-chat serialization, warm-missing-only jobs, and DLQ handling.
- Simulated 12-artist stress behavior without real network calls.
- Worker routes for health, direct GET, webhook, and guarded `/internal/warm-artist`.

---

## File Structure

```
src/
  index.js              # Worker entry (fetch / queue)
  config.js             # env helpers and constants
  messages/fa.js        # Farsi user-facing strings
  routes/http.js        # HTTP routing
  admin/                # /admin dashboard (auth, users, API, HTML)
  bot/                  # commands, search, inline, callbacks, handleUrl
  rj/                   # Radio Javan API + URL/track helpers
  telegram/             # Bot API + sendTrackToUser
  cache/                # Telegram file_id KV cache
  delivery/             # Queue, DLQ, warm-artist
worker.js               # thin re-export of src/index.js for tests
wrangler.toml           # bindings and vars (main = src/index.js)
test/                   # node:test suite
```

---

## What's New

- **Modular `src/` layout** with queue-only artist delivery (legacy KV jobs, watchdog, and `WORKER_SELF` removed).
- **Telegram upload cache**: songs already uploaded by the bot are resent by `file_id`. Cache is keyed per song and per quality (`320`/`256`).
- **Deterministic quality**: 320 kbps is always preferred, with 256 kbps as the only fallback.
- **Queue-backed artist delivery**: long artist catalogs are sent through Cloudflare Queues one song at a time.
- **Per-chat serialization**: a second artist for the same chat waits until the current delivery finishes (or DLQs).
- **Rate-limit aware**: Telegram `429` responses are honored via `retry_after`.
- **Warm endpoint**: `POST /internal/warm-artist`, protected by `JOB_RUNNER_SECRET`.

---

## Contributing

Contributions are welcome! To contribute:

- Open an issue to discuss potential improvements.
- Submit a pull request with your changes.

Ensure your contributions adhere to the coding standards and guidelines of the project.

---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Contact

For any issues or questions, please open an issue in the repository.

Happy coding!
