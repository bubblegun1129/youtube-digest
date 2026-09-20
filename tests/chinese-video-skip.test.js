const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("content script probes caption languages before any transcript fetch", () => {
  const source = read("content.js");

  // The probe reads YouTube's embedded caption tracks and treats a video as
  // Chinese only when every track is Chinese — never from the title/channel.
  assert.match(source, /function getCaptionLanguages\(\)/);
  assert.match(source, /function hasOnlyChineseCaptionTracks\(captionLanguages\)/);
  assert.ok(
    source.indexOf("const ZH_CAPTION_LANGUAGE_PATTERN = /^zh/i;") > -1,
    "the zh caption-language pattern must exist",
  );
  assert.doesNotMatch(source, /isLikelyChineseVideo|CHINESE_SCRIPT_PATTERN/);

  // loadBilingualCaptions must probe BEFORE issuing fetchTranscript.
  const fnStart = source.indexOf("async function loadBilingualCaptions(");
  const idxProbe = source.indexOf(
    "hasOnlyChineseCaptionTracks(getCaptionLanguages())",
    fnStart,
  );
  const idxFetch = source.indexOf('action: "fetchTranscript"', fnStart);
  assert.ok(
    idxProbe > fnStart && idxFetch > idxProbe,
    "the Chinese-video probe must run before the transcript fetch",
  );

  // getVideoInfo responses carry the caption track languages to the panel.
  const idxGetInfo = source.indexOf('message.action === "getVideoInfo"');
  assert.ok(
    source.indexOf("info.captionLanguages = getCaptionLanguages()", idxGetInfo) >
      idxGetInfo,
    "getVideoInfo must include the caption track languages",
  );
});

test("side panel probes caption languages before the transcript fetch", () => {
  const panel = read("sidepanel.js");

  assert.match(panel, /function hasOnlyChineseCaptionTracks\(captionLanguages\)/);
  assert.doesNotMatch(panel, /isLikelyChineseVideo|CHINESE_SCRIPT_PATTERN/);

  const fnStart = panel.indexOf("async function startDigest(");
  const idxProbe = panel.indexOf(
    "hasOnlyChineseCaptionTracks(currentVideoCaptionLanguages)",
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
  // The caption-track probe stays the primary gate; a Chinese title or
  // channel alone must never skip translation.
  const idxCaptionProbe = panel.indexOf(
    "hasOnlyChineseCaptionTracks(currentVideoCaptionLanguages) ||",
    fnStart,
  );
  assert.ok(
    idxCaptionProbe > fnStart,
    "translateTranscript must also gate on the caption track languages",
  );
});

test("background skips the Supadata call when saving notes on Chinese videos", () => {
  const background = read("background.js");

  assert.match(background, /function hasOnlyChineseCaptionTracks\(captionLanguages\)/);
  assert.doesNotMatch(background, /isLikelyChineseVideo|CHINESE_SCRIPT_PATTERN/);

  const fnStart = background.indexOf("async function handleSaveNote(");
  const idxProbe = background.indexOf(
    "!hasOnlyChineseCaptionTracks(captionLanguages)",
    fnStart,
  );
  const idxFetch = background.indexOf("handleFetchTranscript(videoId)", fnStart);
  assert.ok(
    idxProbe > fnStart && idxFetch > idxProbe,
    "the Chinese-video probe must gate the note transcript fetch",
  );

  // handleSaveNote accepts the caption track languages from the caller.
  assert.match(
    background,
    /async function handleSaveNote\([\s\S]*?captionLanguages,?\s*\)/,
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
