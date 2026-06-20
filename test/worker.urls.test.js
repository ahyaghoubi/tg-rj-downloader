import assert from "node:assert/strict";
import test from "node:test";

import {
  extractArtistName,
  extractLinkFromMessage,
  getMp3QualityRank,
  normalizeInput,
  orderSongUrls,
  parseMediaFromUrl,
  resolveSongUrls,
} from "../worker.js";

test("normalizeInput accepts full, schemeless, and short Radio Javan links", () => {
  assert.equal(normalizeInput(" https://play.radiojavan.com/song/Ebi-Test "), "https://play.radiojavan.com/song/Ebi-Test");
  assert.equal(normalizeInput("play.radiojavan.com/artist/ebi"), "https://play.radiojavan.com/artist/ebi");
  assert.equal(normalizeInput("rj.app/m/test"), "https://rj.app/m/test");
  assert.equal(normalizeInput("not a link"), "not a link");
});

test("extractLinkFromMessage supports plain text and Telegram url entities", () => {
  assert.equal(
    extractLinkFromMessage({ text: "play.radiojavan.com/song/Ebi-Test" }),
    "https://play.radiojavan.com/song/Ebi-Test"
  );

  assert.equal(
    extractLinkFromMessage({
      text: "listen https://play.radiojavan.com/artist/ebi now",
      entities: [{ type: "url", offset: 7, length: 39 }],
    }),
    "https://play.radiojavan.com/artist/ebi"
  );
});

test("parseMediaFromUrl and extractArtistName parse expected URL shapes", () => {
  assert.deepEqual(parseMediaFromUrl("https://play.radiojavan.com/song/Ebi-Test"), {
    mediaType: "song",
    mediaName: "Ebi-Test",
  });
  assert.equal(extractArtistName("https://play.radiojavan.com/artist/ebi"), "ebi");
  assert.throws(() => parseMediaFromUrl("https://play.radiojavan.com/song"), /Invalid URL format/);
});

test("quality ranking prefers 320 then 256 then other audio candidates", () => {
  assert.equal(getMp3QualityRank("https://x/media/mp3/mp3-320/a.mp3"), 0);
  assert.equal(getMp3QualityRank("https://x/media/mp3/mp3-256/a.mp3"), 1);
  assert.equal(getMp3QualityRank("https://x/a.mp3"), 2);
  assert.equal(getMp3QualityRank("https://x/media/aac-256/a.m4a"), 3);
  assert.equal(getMp3QualityRank("https://x/media/aac-128/a.m4a"), 4);
});

test("resolveSongUrls upgrades 256 to candidate 320, dedupes, and orders candidates", () => {
  const urls = resolveSongUrls("song", "Ebi-Test", [
    "https://cdn.example.com/media/mp3/mp3-256/Ebi-Test.mp3",
    "https://cdn.example.com/media/mp3/mp3-256/Ebi-Test.mp3",
  ]);

  assert.equal(urls[0], "https://cdn.example.com/media/mp3/mp3-320/Ebi-Test.mp3");
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.some((url) => url.includes("mp3-256")));
});

test("orderSongUrls sorts preferred qualities first", () => {
  const ordered = orderSongUrls([
    "https://x/media/aac-128/a.m4a",
    "https://x/media/mp3/mp3-256/a.mp3",
    "https://x/media/mp3/mp3-320/a.mp3",
  ]);

  assert.match(ordered[0], /mp3-320/);
  assert.match(ordered[1], /mp3-256/);
});
