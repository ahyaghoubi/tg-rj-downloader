import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFallbackUrls,
  artistNamesEqual,
  extractArtistName,
  extractLinkFromMessage,
  getMp3QualityRank,
  hostnameOf,
  normalizeArtistName,
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
  assert.equal(
    extractArtistName("https://play.radiojavan.com/artist/Kamran%20%26%20Hooman"),
    "Kamran & Hooman"
  );
  assert.equal(
    extractArtistName("https://play.radiojavan.com/artist/Kamran%20&%20Hooman"),
    "Kamran & Hooman"
  );
  assert.equal(normalizeArtistName("Kamran%20%26%20Hooman"), "Kamran & Hooman");
  assert.equal(artistNamesEqual("Kamran%20%26%20Hooman", "Kamran & Hooman"), true);
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
  // With API URLs present, constructed CDN fallbacks are skipped.
  assert.ok(urls.every((url) => url.includes("cdn.example.com")));
  assert.ok(urls.length <= 3);
});

test("buildFallbackUrls prefers primary hosts and limits casing variants", () => {
  const urls = buildFallbackUrls("song", "Ebi-Test");
  assert.ok(urls.every((url) => hostnameOf(url) === "host1.rj-mw1.com" || hostnameOf(url) === "host1.rjapp-content.app"));
  assert.ok(urls.some((url) => url.includes("host1.rj-mw1.com/media/mp3/mp3-320/Ebi-Test.mp3")));
  assert.ok(urls.some((url) => url.includes("host1.rj-mw1.com/media/mp3/mp3-320/ebi-test.mp3")));
  assert.equal(
    urls.filter((url) => url.includes("host1.rjapp-content.app") && url.includes("ebi-test")).length,
    0
  );
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
