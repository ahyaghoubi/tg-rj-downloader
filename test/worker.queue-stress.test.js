import assert from "node:assert/strict";
import test from "node:test";

import { createQueuedArtistPayload, runQueuedArtistMessage } from "../worker.js";
import { createEnv, mockTelegramFetch } from "./helpers.js";

test("simulated 12-artist stress stays local, compact, and one-song paced", async () => {
  const telegram = mockTelegramFetch();
  const env = createEnv({ ARTIST_QUEUE_DELAY_SECONDS: "2" });

  try {
    const artists = Array.from({ length: 12 }, (_, artistIndex) => ({
      artistName: `artist-${artistIndex}`,
      tracks: Array.from({ length: 25 }, (_, trackIndex) => ({
        permlink: `Artist-${artistIndex}-Track-${trackIndex}`,
        title: `Track ${trackIndex}`,
        mediaType: "song",
        urls: Array.from(
          { length: 50 },
          (__, urlIndex) => `https://cdn.example.com/${artistIndex}/${trackIndex}/${urlIndex}.mp3`
        ),
      })),
    }));

    const firstPayloads = artists.map(({ artistName, tracks }) =>
      createQueuedArtistPayload("224032101", artistName, tracks)
    );

    for (const payload of firstPayloads) {
      assert.ok(JSON.stringify(payload).length < 128 * 1024);
      assert.equal(payload.tracks[0].urls, undefined);
      await runQueuedArtistMessage(env, payload);
    }

    assert.equal(telegram.calls.length, 12);
    assert.equal(env.queueMessages.length, 12);

    for (const message of env.queueMessages) {
      assert.equal(message.payload.nextIndex, 1);
      assert.equal(message.payload.sent, 1);
      assert.deepEqual(message.options, { delaySeconds: 2 });
      assert.equal(message.payload.tracks[0].urls, undefined);
    }

    const kvProgressWrites = env.ARTIST_JOB_STORE.operations.filter((op) => op.type === "put");
    assert.equal(kvProgressWrites.length, 0);
  } finally {
    telegram.restore();
  }
});
