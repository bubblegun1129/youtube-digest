const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("content script guards chrome.runtime so a dead context never re-requests subtitles", () => {
  const source = read("content.js");

  // The guard exists, checks the API first, and wraps the raw call.
  assert.match(
    source,
    /async function runtimeSend\(message\) \{[\s\S]*?if \(!chrome\?\.runtime\?\.sendMessage\) \{[\s\S]*?error: "Extension context unavailable\. Try reloading the page\."/,
  );

  // Only the wrapper itself may await the messaging API; every business call
  // goes through runtimeSend so failures become a `{ error }` envelope that
  // the caption pipeline can record instead of throwing.
  const rawCalls = source.match(/await chrome\.runtime\.sendMessage\(/g) || [];
  assert.equal(rawCalls.length, 1, "only runtimeSend may call the messaging API");
});

test("bilingual captions request the transcript through runtimeSend", () => {
  const source = read("content.js");
  const captionsRegion = source.slice(
    source.indexOf("async function loadBilingualCaptions"),
  );

  assert.match(captionsRegion, /runtimeSend\(\{/);
  assert.match(captionsRegion, /action: "fetchTranscript"/);
  assert.doesNotMatch(captionsRegion, /chrome\.runtime\.sendMessage\(/);
});

test("captions preference reads and writes go through runtimeSend", () => {
  const source = read("content.js");
  const prefRegion = source.slice(
    source.indexOf("async function restoreCaptionsPreference"),
  );
  assert.match(prefRegion, /runtimeSend\(\{\s*action: "getCaptionsPref"/);
  assert.match(prefRegion, /runtimeSend\(\{\s*action: "setCaptionsPref"/);
});

test("caption failures are recorded so the same video is not re-fetched", () => {
  const source = read("content.js");
  const fn = source.slice(
    source.indexOf("async function loadBilingualCaptions"),
    source.indexOf("function bindCaptionsTimeUpdate"),
  );

  // The top-of-function short-circuit must remain in place.
  assert.match(
    fn,
    /if \(ytdCaptionsState\.failedVideoIds\.has\(videoId\)\) \{/,
  );

  // Any failure — including an unavailable extension context — records the
  // video for the session, so later triggers (SPA navigation, toggling,
  // observer runs) hit the short-circuit instead of re-requesting. Friendly
  // messages win over raw error codes when the background answered.
  assert.match(fn, /ytdCaptionsState\.failedVideoIds\.add\(videoId\);/);
  assert.match(fn, /showCaptionsError\(result\.message\)/);
  assert.match(fn, /\} else if \(result\?\.error\) \{/);
});

test("translation queue stops on an unavailable context instead of looping", () => {
  const source = read("content.js");
  const queueRegion = source.slice(
    source.indexOf("async function processCaptionsQueue"),
    source.indexOf("function resetCaptionsState"),
  );

  assert.match(queueRegion, /action: "translateContent"/);
  assert.match(queueRegion, /runtimeSend\(\{/);
  assert.match(
    queueRegion,
    /\} else if \(result\?\.error\) \{/,
  );
  // The failure branch must exit the loop rather than continue to the next
  // batch on a dead runtime.
  assert.match(
    queueRegion,
    /Captions translation unavailable[\s\S]*?break;/,
  );
});

test("side panel guards messaging and stops the digest on a dead runtime", () => {
  const panel = read("sidepanel.js");

  assert.match(
    panel,
    /async function runtimeSend\(message\) \{[\s\S]*?if \(!chrome\?\.runtime\?\.sendMessage\)/,
  );
  assert.match(
    panel,
    /async function tabsSend\(tabId, message\) \{[\s\S]*?if \(!chrome\?\.tabs\?\.sendMessage\)/,
  );

  // startDigest must use the guarded channel and bail out when the context is
  // gone, instead of falling through and looping back into another fetch.
  const digest = panel.slice(
    panel.indexOf("async function startDigest("),
    panel.indexOf("function chooseVideoMetadata"),
  );
  assert.match(digest, /const transcriptResult = await runtimeSend\(\{/);
  assert.match(
    digest,
    /transcriptResult\?\.error && !transcriptResult\.transcript/,
  );
  assert.match(
    digest,
    /showError\("Could not fetch transcript", transcriptResult\.error\)/,
  );
});
