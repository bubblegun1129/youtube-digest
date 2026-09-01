const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const background = fs.readFileSync(
  path.resolve(__dirname, "..", "background.js"),
  "utf8",
);
const content = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);

test("background caches caption-less failures so the same video is not re-fetched", () => {
  // 24h TTL constant exists.
  assert.match(
    background,
    /const TRANSCRIPT_FAILURE_CACHE_TTL_MS = 24 \* 60 \* 60 \* 1000;/,
    "failure cache TTL should be 24 hours",
  );

  // Failure read/write helpers exist.
  assert.match(
    background,
    /async function readFailedTranscript\(videoId\)[\s\S]*?async function writeFailedTranscript\(videoId, transcriptResult\)/,
  );
  assert.match(
    background,
    /function failedTranscriptCacheKey\(videoId\)\s*\{\s*return `digest_failed_\$\{videoId\}`;\s*\}/,
    "failure cache must use a distinct key so it never shadows a real digest",
  );
});

test("only video-property errors are cacheable; transient errors are not", () => {
  assert.match(
    background,
    /const TRANSCRIPT_CACHEABLE_ERRORS = new Set\(\[[\s\S]*?"NO_TRANSCRIPT"[\s\S]*?"EMPTY_TRANSCRIPT"[\s\S]*?\]\);/,
  );
  // Transient failures must NOT be cached (user should be able to retry).
  assert.doesNotMatch(
    background,
    /TRANSCRIPT_CACHEABLE_ERRORS\s*=\s*new Set\(\[[^\]]*"RATE_LIMITED"/,
  );
  assert.doesNotMatch(
    background,
    /TRANSCRIPT_CACHEABLE_ERRORS\s*=\s*new Set\(\[[^\]]*"NO_SUPADATA_KEY"/,
  );
});

test("handleFetchTranscript consults the failure cache before hitting Supadata", () => {
  // Order matters: success cache -> failure cache -> in-flight promise -> API.
  const fnStart = background.indexOf("async function handleFetchTranscript(");
  const idxSuccessCache = background.indexOf("readCachedTranscript(videoId);", fnStart);
  const idxFailureCache = background.indexOf("readFailedTranscript(videoId);", idxSuccessCache);
  const idxInFlight = background.indexOf("transcriptFetchPromises.has(videoId)", idxFailureCache);
  const idxApi = background.indexOf("fetchTranscriptFromSupadata(videoId)", idxInFlight);
  assert.ok(
    idxSuccessCache > fnStart &&
      idxFailureCache > idxSuccessCache &&
      idxInFlight > idxFailureCache &&
      idxApi > idxInFlight,
    "failure cache must be checked before any Supadata call",
  );

  // Successful fetches write the success cache; failures write the failure cache.
  const thenStart = background.indexOf("fetchTranscriptFromSupadata(videoId).then", idxApi);
  const idxSuccessWrite = background.indexOf("writeCachedTranscript(videoId, result);", thenStart);
  const idxFailureWrite = background.indexOf("writeFailedTranscript(videoId, result);", idxSuccessWrite);
  assert.ok(
    idxSuccessWrite > thenStart && idxFailureWrite > idxSuccessWrite,
    "fetch result must route to the success or failure cache",
  );
});

test("content script marks caption-less videos so it never re-fetches them", () => {
  assert.match(
    content,
    /failedVideoIds: new Set\(\), \/\/ videos confirmed to have no captions this session/,
  );

  // Checked before the per-video pages guard, so a failed video short-circuits.
  assert.match(
    content,
    /async function loadBilingualCaptions\(\) \{[\s\S]*?if \(ytdCaptionsState\.failedVideoIds\.has\(videoId\)\) \{[\s\S]*?showCaptionsError\([\s\S]*?return;[\s\S]*?\}[\s\S]*?if \(ytdCaptionsState\.videoId === videoId && ytdCaptionsState\.pages\.length\)/,
  );

  // The failure branch records the video.
  assert.match(
    content,
    /\} else \{\s*ytdCaptionsState\.failedVideoIds\.add\(videoId\);[\s\S]*?showCaptionsError\(result\?\.message/,
  );

  // resetCaptionsState clears the set so a fresh navigation can try again.
  assert.match(
    content,
    /function resetCaptionsState\(\) \{[\s\S]*?ytdCaptionsState\.failedVideoIds\.clear\(\);/,
  );
});
