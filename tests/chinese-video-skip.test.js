const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("content script probes Chinese videos before any transcript fetch", () => {
  const source = read("content.js");

  // The probe exists and matches CJK characters.
  assert.match(
    source,
    /const CHINESE_SCRIPT_PATTERN = \/\[\\u3400-\\u9fff\\uf900-\\ufaff\]\/;/,
  );
  assert.match(
    source,
    /function isLikelyChineseVideo\(title, channelName\)/,
  );

  // loadBilingualCaptions must probe BEFORE issuing fetchTranscript.
  const fnStart = source.indexOf("async function loadBilingualCaptions(");
  const idxProbe = source.indexOf(
    "isLikelyChineseVideo(videoInfo.title, videoInfo.channelName)",
    fnStart,
  );
  const idxFetch = source.indexOf('action: "fetchTranscript"', fnStart);
  assert.ok(
    idxProbe > fnStart && idxFetch > idxProbe,
    "the Chinese-video probe must run before the transcript fetch",
  );
});

test("side panel probes Chinese videos before the transcript fetch", () => {
  const panel = read("sidepanel.js");

  assert.match(panel, /function isLikelyChineseVideo\(title, channelName\)/);

  const fnStart = panel.indexOf("async function startDigest(");
  const idxProbe = panel.indexOf(
    "isLikelyChineseVideo(currentVideoTitle, currentChannelName)",
    fnStart,
  );
  const idxFetch = panel.indexOf('action: "fetchTranscript"', fnStart);
  assert.ok(
    idxProbe > fnStart && idxFetch > idxProbe,
    "the Chinese-video probe must run before the transcript fetch",
  );

  // The panel must explain the skip instead of showing a transcript error.
  assert.match(
    panel,
    /showError\(\s*"中文视频已跳过"/,
  );
});

test("side panel skips translation for Chinese transcripts in cache", () => {
  const panel = read("sidepanel.js");
  const fnStart = panel.indexOf("async function translateTranscript(");
  const idxZhProbe = panel.indexOf(
    '/^zh/i.test(String(currentTranscriptLanguage || ""))',
    fnStart,
  );
  assert.ok(
    idxZhProbe > fnStart,
    "translateTranscript must skip Chinese source transcripts",
  );
});

test("background skips the Supadata call when saving notes on Chinese videos", () => {
  const background = read("background.js");

  assert.match(background, /function isLikelyChineseVideo\(title, channelName\)/);

  const fnStart = background.indexOf("async function handleSaveNote(");
  const idxProbe = background.indexOf(
    "!isLikelyChineseVideo(videoTitle, channelName)",
    fnStart,
  );
  const idxFetch = background.indexOf("handleFetchTranscript(videoId)", fnStart);
  assert.ok(
    idxProbe > fnStart && idxFetch > idxProbe,
    "the Chinese-video probe must gate the note transcript fetch",
  );

  // With no transcript, the note still saves (title-only) instead of crashing.
  assert.match(
    background,
    /let cleanedText;\s*let rawText = "";\s*if \(matchedLine\)/,
  );
  assert.match(
    background,
    /rawText: rawText,/,
  );
});
