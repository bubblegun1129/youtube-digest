const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
  assert.match(source, /isTranslatablePageSelection\(text\)/);
  assert.match(source, /action: "translateContent"/);
  assert.match(source, /contentType: "selectedText"/);
  assert.match(source, /targetLanguage: "zh"/);
  assert.match(source, /PAGE_TRANSLATE_MAX_SELECTION_CHARS = 4000/);
  assert.doesNotMatch(source, /\\p\{/);
  assert.doesNotMatch(source, /youtube\.com/);
});

test("page translation ignores Chinese, links, and non-text selections", () => {
  const sandbox = {
    chrome: { runtime: { sendMessage() {} } },
    document: {
      addEventListener() {},
      createElement() {
        return {
          addEventListener() {},
          attachShadow() {
            return {
              getElementById() {
                return { className: "", textContent: "" };
              },
            };
          },
          style: {},
        };
      },
      documentElement: { appendChild() {} },
    },
    window: {
      addEventListener() {},
      getSelection() {
        return null;
      },
      innerHeight: 800,
      innerWidth: 1200,
    },
    URL,
    setTimeout() {},
    clearTimeout() {},
  };

  vm.createContext(sandbox);
  vm.runInContext(read("page-translate.js"), sandbox);

  const accepts = sandbox.isTranslatablePageSelection;
  assert.equal(typeof accepts, "function");

  assert.equal(accepts("This is a useful English sentence."), true);
  assert.equal(accepts("OpenAI API pricing"), true);
  assert.equal(accepts("This English sentence was selected 中文"), true);
  assert.equal(accepts("これは日本語の文章です"), true);
  assert.equal(accepts("这是一段中文"), false);
  assert.equal(accepts("中文内容很多很多 OpenAI"), false);
  assert.equal(accepts("https://example.com/docs"), false);
  assert.equal(accepts("www.example.com/path?q=1"), false);
  assert.equal(accepts("support@example.com"), false);
  assert.equal(accepts("12345"), false);
  assert.equal(accepts("— / + ="), false);
  assert.equal(accepts("A"), false);
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
    /async function translatePageSelection\(text\) \{[\s\S]*?typeof chrome === "undefined"[\s\S]*?throw new Error\("Extension context unavailable[\s\S]*?\);[\s\S]*?\}[\s\S]*?await chrome\.runtime\.sendMessage\(/,
  );
});
