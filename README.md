# Radio Javan Telegram Bot

A Cloudflare Worker script that turns your Telegram bot into a Radio Javan media downloader. Users simply send a Radio Javan link (song, podcast, or video) to the bot and receive the corresponding media file directly in Telegram.

---

## Features

- **Telegram Webhook Integration**  
  Listens for updates on the `/webhook/<BOT_TOKEN>` route and processes commands or media links.

- **Media Processing**  
  - Automatically resolves shortened URLs (e.g., `https://rj.app/`).
  - Determines media type (song, podcast, or video) and fetches the appropriate file.

- **File Delivery**  
  - Sends audio files via the Telegram [`sendAudio`](https://core.telegram.org/bots/api#sendaudio) API.
  - Attempts to send documents using the [`sendDocument`](https://core.telegram.org/bots/api#senddocument) API when audio delivery is not applicable.
  - Provides fallback download links if an upload fails.

- **Robust Error Handling**  
  Provides user-friendly error messages for unsupported media types or file upload issues.

---

## How It Works

1. **Webhook Handling**  
   The worker intercepts POST requests at `/webhook/<BOT_TOKEN>` from Telegram and processes incoming updates. It recognizes commands (like `/start`) and media links, triggering file processing.

2. **Media URL Resolution**  
   For URLs starting with `https://rj.app/`, the worker resolves any redirections to obtain the full media URL.

3. **Fetching Media**  
   Based on the detected media type in the URL (e.g., `song`, `podcast`, or `video`), the script compiles a set of candidate media URLs and fetches the media file as a Blob.

4. **Sending Media to Telegram**  
   - Audio files are transmitted using the [`sendAudio`](https://core.telegram.org/bots/api#sendaudio) endpoint, with a default `.mp3` extension.
   - For other file types, the script employs the [`sendDocument`](https://core.telegram.org/bots/api#senddocument) endpoint.
   - When a file cannot be uploaded, a fallback download link is sent to the user.

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
   - Set up an environment variable named `BOT_TOKEN` with your Telegram Bot Token.

3. **Set the Telegram Webhook**

   Use the following command (replace `<BOT_TOKEN>` and `<your-worker-subdomain>` with your actual Bot Token and Cloudflare Worker subdomain):

   ```sh
   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" -d "url=https://<your-worker-subdomain>.workers.dev/webhook/<BOT_TOKEN>"
   ```

4. **Testing the Bot**

   - Start a conversation with your bot on Telegram.
   - Send the `/start` command to receive a welcome message.
   - Send a Radio Javan media link (e.g., `https://rj.app/example`) to trigger media processing and delivery.

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
