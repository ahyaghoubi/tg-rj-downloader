import assert from "node:assert/strict";
import test from "node:test";

import { extractTracksFromPayload } from "../worker.js";

test("extractTracksFromPayload finds nested songs and dedupes permalinks", () => {
  const tracks = extractTracksFromPayload({
    artist: {
      songs: [
        {
          permlink: "Ebi-One",
          title: "One",
          link: "https://cdn.example.com/media/mp3/mp3-256/Ebi-One.mp3",
        },
        {
          permlink: "ebi-one",
          title: "Duplicate",
          link: "https://cdn.example.com/media/mp3/mp3-256/Ebi-One.mp3",
        },
      ],
      albums: [
        {
          tracks: [
            {
              permlink: "Ebi-Two",
              song: "Two",
              hq_link: "https://cdn.example.com/media/mp3/mp3-320/Ebi-Two.mp3",
            },
          ],
        },
      ],
    },
  });

  assert.deepEqual(
    tracks.map((track) => track.permlink),
    ["Ebi-One", "Ebi-Two"]
  );
  assert.equal(tracks[0].title, "One");
  assert.equal(tracks[1].title, "Two");
});

test("extractTracksFromPayload skips video, podcast, and items without direct links", () => {
  const tracks = extractTracksFromPayload({
    songs: [
      {
        permlink: "Song-Without-Link",
        title: "No link",
      },
      {
        permlink: "Video-Item",
        type: "video",
        link: "https://cdn.example.com/media/mp4/music_video/Video-Item.mp4",
      },
      {
        permlink: "Podcast-Item",
        type: "podcast",
        link: "https://cdn.example.com/podcast/Podcast-Item.mp3",
      },
      {
        permlink: "Valid-Song",
        lq_link: "https://cdn.example.com/media/mp3/mp3-256/Valid-Song.mp3",
      },
    ],
  });

  assert.deepEqual(
    tracks.map((track) => track.permlink),
    ["Valid-Song"]
  );
});

test("extractTracksFromPayload returns empty array for empty or irrelevant payloads", () => {
  assert.deepEqual(extractTracksFromPayload(null), []);
  assert.deepEqual(extractTracksFromPayload({ artist: { name: "ebi" } }), []);
});
