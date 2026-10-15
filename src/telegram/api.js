import { RATE_LIMIT_FALLBACK_SECONDS } from "../config.js";

class TelegramRateLimitError extends Error {
  constructor(retryAfter) {
    super(`Telegram rate limited; retry after ${retryAfter}s`);
    this.name = "TelegramRateLimitError";
    this.retryAfter = retryAfter;
  }
}

async function callTelegram(botToken, method, { body, headers } = {}) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers,
    body,
  });

  const result = await response.json();
  if (!result.ok) {
    if (response.status === 429 || result.error_code === 429) {
      const retryAfter = Number(result.parameters?.retry_after) || RATE_LIMIT_FALLBACK_SECONDS;
      throw new TelegramRateLimitError(retryAfter);
    }
    throw new Error(result.description || `Telegram ${method} failed`);
  }

  return result.result;
}

export { TelegramRateLimitError, callTelegram };
