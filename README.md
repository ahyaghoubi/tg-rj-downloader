# Radio Javan Telegram Bot

A Cloudflare Worker script that turns your Telegram bot into a Radio Javan media downloader. Users simply send a Radio Javan song link to the bot and receive the audio file directly in Telegram.

---

## Features

- **Telegram Webhook Integration**  
  Listens for updates on the `/webhook` route and processes commands or media links.

- **Media Processing**  
  - Automatically resolves shortened URLs (e.g., `https://rj.app/`).
  - Determines media type (song or artist) and fetches the appropriate audio file.
  - Skips videos and podcasts on artist pages and rejects direct video/podcast links.
  - Prefers direct download URLs returned by the Radio Javan API (`link`, `hq_link`, `lq_link`).
  - Falls back to multiple CDN hosts, qualities, and permlink casing when API links are unavailable.
  - For artist pages, sends audio for artists with fewer than 50 songs; for 50 or more, sends a `.txt` file with download links.

- **Future-Proof Resolution**  
  - Uses `/api/p/mp3` and `/api/p/artist` metadata endpoints first.
  - Tries alternate artist API versions if the primary request fails.
  - Validates candidate URLs with HTTP `HEAD` before downloading.
  - Supports optional `RJ_API_KEY` and `RJ_USER_AGENT` environment variables for credential rotation without code changes.

- **File Delivery**  
  - Sends audio files via the Telegram [`sendAudio`](https://core.telegram.org/bots/api#sendaudio) API.
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
   2. **Constructed fallbacks** — tries `mp3-320` first across CDN hosts and permlink casing, then falls back to `mp3-256`. API `mp3-256` links are also upgraded to `mp3-320` when that file exists.
   3. **Validation** — checks each candidate with HTTP `HEAD` and downloads the first valid file.

   Artist pages use the Radio Javan API with `x-api-key`, `x-rj-user-agent`, `Referer`, and `Origin` headers.

4. **Sending Media to Telegram**  
   Audio files are transmitted using the [`sendAudio`](https://core.telegram.org/bots/api#sendaudio) endpoint. When a file cannot be uploaded, a fallback download link is sent to the user.

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
   - Copy the contents of `worker.js` into the online editor.
   - Set up environment variables:
     - `BOT_TOKEN` — your Telegram Bot Token (**required**, set as a Worker secret or variable)
     - `RJ_API_KEY` — Radio Javan API key (optional; defaults built in)
     - `RJ_USER_AGENT` — Radio Javan client user agent (optional; defaults built in)

   After deploying, open `https://<your-worker>.workers.dev/health` in a browser. You should see:

   ```json
   {"ok":true,"bot":"your_bot_username","error":null}
   ```

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

## Troubleshooting

- **Bot does not respond** — Check `getWebhookInfo` points to `/webhook` on your worker, and that `BOT_TOKEN` is set in Cloudflare **Settings → Variables**. The worker returns `200 OK` immediately and processes updates in the background via `ctx.waitUntil`.
- **Artist pages are slow** — Artists with fewer than 50 songs are sent as audio. Artists with 50+ songs (e.g. [Ebi](https://play.radiojavan.com/artist/ebi)) receive a `links.txt` file instead.
- **403 on artist API** — Ensure `RJ_API_KEY` and `RJ_USER_AGENT` are set, or redeploy with the built-in defaults.

---

## File Structure

- **README.md**: This file.
- **worker.js**: The main Cloudflare Worker script responsible for:
  - Handling incoming Telegram updates via webhooks.
  - Resolving media URLs from Radio Javan.
  - Fetching and sending media files using Telegram's APIs.

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
