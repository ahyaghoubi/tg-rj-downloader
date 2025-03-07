export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // Handle webhook updates from Telegram
      if (request.method === "POST" && url.pathname === `/webhook/${env.BOT_TOKEN}`) {
        const update = await request.json();
        return handleUpdate(update, env);
      }

      // Handle requests with link and userid parameters
      if (request.method === "GET" && url.pathname === "/") {
        const link = url.searchParams.get("link");
        const userid = url.searchParams.get("userid");

        if (!link || !userid) {
          return new Response("Missing 'link' or 'userid' parameter", { status: 400 });
        }

        // Process the link and send the file
        await handleUrl(userid, link, env);
        return new Response("File processing initiated", { status: 200 });
      }

      // Default response for other routes
      return new Response("Cloudflare Worker for Telegram Bot is running!", {
        status: 200,
      });
    } catch (err) {
      console.error(`Error: ${err.message}`);
      return new Response("Error: Unable to process your request.", {
        status: 500,
      });
    }
  },
};

// Handle incoming updates from Telegram
async function handleUpdate(update, env) {
  const message = update.message || update.edited_message;
  if (!message) return new Response("No message found", { status: 200 });

  const userId = message.from.id;
  const text = message.text;

  if (text === "/start") {
    await sendMessage(userId, "Welcome to the bot! 🚀", env.BOT_TOKEN);
  } else if (text.startsWith("http")) {
    await handleUrl(userId, text, env);
  } else {
    await sendMessage(userId, "Invalid input! Please send a valid link.", env.BOT_TOKEN);
  }

  return new Response("Update handled", { status: 200 });
}

// Handle URL parsing and media processing
async function handleUrl(userId, url, env) {
  try {
    if (url.startsWith("https://rj.app/")) {
      url = await resolveRedirect(url); // Resolve the redirection
      console.log(`Redirected to: ${url}`);
    }

    const parsedUrl = new URL(url);
    const mediaType = parsedUrl.pathname.split("/")[1];
    const mediaName = parsedUrl.pathname.split("/")[2];

    const mediaUrls = getMediaUrls(mediaType, mediaName);

    if (!mediaUrls.length) {
      await sendMessage(userId, "Unsupported media type!", env.BOT_TOKEN);
      return;
    }

    if (mediaType === "podcast" || mediaType === "video" || mediaType === "song") {
      try {
        const fileBlob = await fetchFileAsBlob(mediaUrls);
        const fileName = `${mediaName}.mp3`; // Defaulting to .mp3 for audio files
        await sendAudio(userId, fileBlob, fileName, env.BOT_TOKEN);
      } catch (err) {
        console.error(`Error sending audio: ${err.message}`);
        await sendMessage(
          userId,
          `The file could not be uploaded to Telegram. Download it here: ${mediaUrls[0] || mediaUrls[1]}`,
          env.BOT_TOKEN
        );
      }
    } else {
      const success = await trySendDocument(userId, mediaUrls[0], env.BOT_TOKEN);
      if (!success) {
        await sendMessage(
          userId,
          `The file could not be uploaded to Telegram. Download it here: ${mediaUrls[0] || mediaUrls[1]}`,
          env.BOT_TOKEN
        );
      }
    }
  } catch (err) {
    console.error(`Error in handleUrl: ${err.message}`);
    await sendMessage(
      userId,
      `The file could not be processed. Download it here: ${url}`,
      env.BOT_TOKEN
    );
  }
}

// Resolve redirect for https://rj.app/ links
async function resolveRedirect(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Accept": "*/*",
      },
    });

    if (response.ok) {
      console.log(`Resolved URL: ${response.url}`);
      return response.url; // Return the resolved URL
    } else {
      throw new Error(`Failed to resolve redirect: HTTP ${response.status}`);
    }
  } catch (err) {
    console.error(`Error resolving redirect: ${err.message}`);
    throw new Error("Could not resolve the redirect.");
  }
}

// Get media URLs based on type and name
function getMediaUrls(mediaType, mediaName) {
  switch (mediaType) {
    case "song":
      return [
        `https://host2.rj-mw1.com/media/mp3/mp3-320/${mediaName}.mp3`,
        `https://host1.rj-mw1.com/media/mp3/mp3-320/${mediaName}.mp3`,
      ];
    case "podcast":
      return [
        `https://host2.rj-mw1.com/media/podcast/mp3-320/${mediaName}.mp3`,
        `https://host1.rj-mw1.com/media/podcast/mp3-320/${mediaName}.mp3`,
      ];
    case "video":
      return [
        `https://host2.rj-mw1.com/media/music_video/hd/${mediaName}.mp4`,
        `https://host1.rj-mw1.com/media/music_video/hd/${mediaName}.mp4`,
      ];
    default:
      return [];
  }
}

// Fetch file as Blob with retry and logging
async function fetchFileAsBlob(urls) {
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          "Referer": url,
          "Accept": "*/*",
        },
        redirect: "follow",
      });

      if (response.ok) {
        const blob = await response.blob();
        if (blob.size > 9) {
          return blob;
        } else {
          console.warn(`Unusually small file (${blob.size} bytes) from ${url}`);
        }
      } else {
        console.warn(`Failed to fetch from ${url}: HTTP ${response.status}`);
        const text = await response.text();
        console.log(`Response body: ${text}`);
      }
    } catch (err) {
      console.error(`Error fetching from ${url}: ${err.message}`);
    }
  }
  throw new Error("Failed to fetch file from all provided URLs.");
}

// Send an audio file as a Blob
async function sendAudio(chatId, fileBlob, fileName, botToken) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("audio", new File([fileBlob], fileName));

  const apiUrl = `https://api.telegram.org/bot${botToken}/sendAudio`;
  const response = await fetch(apiUrl, {
    method: "POST",
    body: formData,
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Failed to send audio: ${result.description}`);
  }
}

// Try sending a document to Telegram
async function trySendDocument(chatId, fileUrl, botToken) {
  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, document: fileUrl }),
    });
    if (!response.ok) {
      console.error(`Failed to send document: ${response.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Error sending document: ${err.message}`);
    return false;
  }
}

// Send a message
async function sendMessage(chatId, text, botToken) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
