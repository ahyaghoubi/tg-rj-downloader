import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAudioMeta,
  compactQueuedTrack,
  extractPlaylistsFromPayload,
  handleStartPayload,
  makeStartPayload,
  presentArtistMenu,
  processUpdate,
  resolveStartPayload,
  searchRadioJavan,
  selectArtistTracks,
} from "../worker.js";
import { createEnv, mockFetch } from "./helpers.js";

test("extractPlaylistsFromPayload normalizes nested search/artist playlist entries", () => {
  const playlists = extractPlaylistsFromPayload({
    playlists: [
      {
        name: "By Radio Javan",
        playlist: {
          id: "07ad54184f83",
          title: "Best of Chaartaar",
          items_count: 30,
          subtype: "mp3",
        },
      },
      {
        playlist: {
          id: "video-list",
          title: "Videos",
          subtype: "video",
        },
      },
    ],
  });

  assert.deepEqual(playlists, [
    { id: "07ad54184f83", title: "Best of Chaartaar", count: 30, createdBy: "By Radio Javan" },
  ]);
});

test("selectArtistTracks returns newest N by createdAt", () => {
  const selected = selectArtistTracks(
    [
      { permlink: "old", createdAt: "2014-01-01T00:00:00Z" },
      { permlink: "new", createdAt: "2024-01-01T00:00:00Z" },
      { permlink: "mid", createdAt: "2020-01-01T00:00:00Z" },
    ],
    2
  );
  assert.deepEqual(
    selected.map((t) => t.permlink),
    ["new", "mid"]
  );
});

test("searchRadioJavan includes playlists", async () => {
  const fetchMock = mockFetch(({ url }) => {
    if (url.includes("/api/p/search?")) {
      return new Response(
        JSON.stringify({
          artists: [],
          mp3s: [],
          playlists: [
            {
              name: "By RJ",
              type: "playlist",
              playlist: { id: "abc123", title: "Persian Tea", items_count: 60, subtype: "mp3" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("{}", { status: 200 });
  });

  try {
    const result = await searchRadioJavan(createEnv(), "persian");
    assert.equal(result.playlists[0].id, "abc123");
    assert.equal(result.playlists[0].title, "Persian Tea");
  } finally {
    fetchMock.restore();
  }
});

test("presentArtistMenu shows latest/all/playlist choices for large catalogs", async () => {
  const bodies = [];
  const fetchMock = mockFetch(({ url, init }) => {
    if (url.includes("sendMessage")) {
      bodies.push(init.body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/p/artist?")) {
      const songs = Array.from({ length: 40 }, (_, i) => ({
        permlink: `Song-${i}`,
        title: `Song ${i}`,
        created_at: `2020-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        link: `https://cdn.example.com/media/mp3/mp3-320/Song-${i}.mp3`,
      }));
      return new Response(
        JSON.stringify({
          mp3s: songs,
          playlists: [
            {
              playlist: { id: "pl1", title: "Best Of", items_count: 12, subtype: "mp3" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("{}", { status: 200 });
  });

  try {
    await presentArtistMenu("1", "Ebi", createEnv());
    const joined = bodies.join("\n");
    assert.match(joined, /آخرین 10/);
    assert.match(joined, /همهٔ آهنگ‌ها \(40\)/);
    assert.match(joined, /Best Of/);
    assert.match(joined, /"p:pl1"|p:pl1/);
  } finally {
    fetchMock.restore();
  }
});

test("start payload round-trips and /start deep link downloads a song", async () => {
  const env = createEnv();
  const payload = await makeStartPayload(env, "s", "Ebi-One");
  assert.equal(payload, "s_Ebi-One");
  assert.deepEqual(await resolveStartPayload(env, payload), { type: "s", value: "Ebi-One" });

  const bodies = [];
  const fetchMock = mockFetch(({ url, init }) => {
    if (url.startsWith("https://api.telegram.org/")) {
      bodies.push(init.body);
      return new Response(JSON.stringify({ ok: true, result: { audio: { file_id: "x" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/p/mp3?")) {
      return new Response(
        JSON.stringify({
          permlink: "Ebi-One",
          song: "One",
          artist: "Ebi",
          duration: 200,
          link: "https://cdn.example.com/media/mp3/mp3-320/Ebi-One.mp3",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("{}", { status: 200 });
  });

  try {
    await handleStartPayload("1", "s_Ebi-One", env, "https://worker.test");
    assert.match(bodies.join("\n"), /Ebi-One|sendAudio/);
  } finally {
    fetchMock.restore();
  }
});

test("buildAudioMeta and compactQueuedTrack keep title/performer/duration", () => {
  assert.deepEqual(
    buildAudioMeta({ title: "One", artist: "Ebi", duration: 201.6 }),
    { title: "One", performer: "Ebi", duration: 202 }
  );
  assert.deepEqual(
    compactQueuedTrack({
      permlink: "Ebi-One",
      title: "One",
      artist: "Ebi",
      duration: 200,
      mediaType: "song",
      urls: ["https://x"],
    }),
    { permlink: "Ebi-One", title: "One", mediaType: "song", artist: "Ebi", duration: 200 }
  );
});

test("processUpdate search shows playlist buttons", async () => {
  const bodies = [];
  const fetchMock = mockFetch(({ url, init }) => {
    if (url.includes("sendMessage")) {
      bodies.push(init.body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/p/search?")) {
      return new Response(
        JSON.stringify({
          playlists: [
            {
              type: "playlist",
              playlist: { id: "tea", title: "Persian Tea", items_count: 60, subtype: "mp3" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("{}", { status: 200 });
  });

  try {
    await processUpdate({ message: { chat: { id: 1 }, text: "/search tea" } }, createEnv(), "https://x");
    assert.match(bodies.join("\n"), /پلی‌لیست/);
    assert.match(bodies.join("\n"), /Persian Tea/);
    assert.match(bodies.join("\n"), /p:tea/);
  } finally {
    fetchMock.restore();
  }
});
