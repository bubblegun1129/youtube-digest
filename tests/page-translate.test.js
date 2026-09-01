const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("ordinary web pages receive the selection translation content script", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const script = manifest.content_scripts.find((item) =>
    item.js.includes("page-translate.js")
  );

  assert.ok(script, "page translation content script must be registered");
  assert.deepEqual(script.matches, ["http://*/*", "https://*/*"]);
  assert.deepEqual(script.exclude_matches, ["https://www.youtube.com/*"]);
  assert.equal(script.run_at, "document_idle");
});

test("page translation script sends selected text to the translation action", () => {
  const source = read("page-translate.js");

  assert.match(source, /window\.getSelection\(\)/);
  assert.match(source, /action: "translateContent"/);
  assert.match(source, /contentType: "selectedText"/);
  assert.match(source, /targetLanguage: "zh"/);
  assert.match(source, /PAGE_TRANSLATE_MAX_SELECTION_CHARS = 4000/);
  assert.doesNotMatch(source, /youtube\.com/);
});

test("page translation debounces rapid selections into a single request", () => {
  const source = read("page-translate.js");

  assert.match(source, /PAGE_TRANSLATE_DEBOUNCE_MS = 300/);
  assert.match(source, /setTimeout\([\s\S]*?PAGE_TRANSLATE_DEBOUNCE_MS\)/);
  // Each mouseup clears the pending timer before scheduling a new one.
  assert.match(source, /clearTimeout\(pageTranslateDebounceTimer\)[\s\S]*?setTimeout\(/);
  // Cancelling the selection (hide) also cancels the pending request.
  assert.match(source, /function hidePageTranslatePopup\(\) \{[\s\S]*?clearTimeout\(pageTranslateDebounceTimer\)/);
});

test("page translation caches successful results and skips the API on re-select", () => {
  const source = read("page-translate.js");

  assert.match(source, /const pageTranslateCache = new Map\(\)/);
  // The API call is only reached after the cache lookup misses.
  assert.match(
    source,
    /pageTranslateCache\.get\(text\)[\s\S]*?if \(cached !== undefined\) \{[\s\S]*?setPageTranslatePopupContent\(cached, "text"\)[\s\S]*?return;[\s\S]*?\}[\s\S]*?translatePageSelection\(text\)/,
  );
  // Only successful translations are stored.
  assert.match(source, /pageTranslateCache\.set\(text, translatedText\)/);
  // The cache write happens in the try (success) branch, not in catch.
  assert.match(
    source,
    /const translatedText = await translatePageSelection\(text\);[\s\S]*?pageTranslateCache\.set\(text, translatedText\)/,
  );
});

test("page translation guards against missing chrome.runtime context", () => {
  const source = read("page-translate.js");

  // Guard appears inside translatePageSelection, before any sendMessage call.
  assert.match(
    source,
    /async function translatePageSelection\(text\) \{[\s\S]*?if \(!chrome\?\.runtime\?\.sendMessage\) \{[\s\S]*?throw new Error\("Extension context unavailable[\s\S]*?\);[\s\S]*?\}[\s\S]*?await chrome\.runtime\.sendMessage\(/,
  );
});
