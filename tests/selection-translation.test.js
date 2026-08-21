const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadContentHelpers() {
  const sandbox = {
    console,
    document: {
      readyState: "loading",
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({ style: {}, addEventListener() {} }),
    },
    window: {
      location: { pathname: "/blog" },
      addEventListener() {},
    },
    chrome: {
      runtime: {
        async sendMessage() {
          return { success: true };
        },
        onMessage: { addListener() {} },
      },
    },
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("selection-translate.js"), sandbox);
  return sandbox.__YTD_SELECTION_TRANSLATION_TESTING__;
}

test("page selection translation is wired through the content script and background", () => {
  const selectionScript = read("selection-translate.js");
  const content = read("content.js");
  const background = read("background.js");
  const sidepanel = read("sidepanel.js");
  const manifest = JSON.parse(read("manifest.json"));

  assert.doesNotMatch(content, /action: "translateSelection"/);
  assert.match(selectionScript, /setupSelectionTranslation\(\)/);
  assert.match(selectionScript, /action: "translateSelection"/);
  assert.match(selectionScript, /showSelectionTranslation/);
  assert.match(selectionScript, /event\.button !== 0/);
  assert.match(background, /contextMenus\.create/);
  assert.match(background, /翻译成中文/);
  assert.ok(manifest.permissions.includes("contextMenus"));
  assert.match(selectionScript, /ytd-selection-translator/);
  assert.match(selectionScript, /attachShadow\(\{ mode: "open" \}\)/);
  assert.doesNotMatch(selectionScript, /pathname\.includes\("\/watch"\)/);
  assert.match(background, /message\.action === "translateSelection"/);
  assert.match(background, /async function handleTranslateSelection\(/);
  assert.match(sidepanel, /selection-translation-card/);
  assert.match(sidepanel, /action: "translateSelection"/);
  assert.ok(
    manifest.content_scripts.some(
      (script) =>
        (script.js || []).includes("selection-translate.js") &&
        (script.matches || []).includes("https://*/*"),
    ),
  );
});

test("page selection helper ignores empty, punctuation-only, editable, and oversized text", () => {
  const {
    normalizeSelectedText,
    isMostlyChineseSelection,
    shouldOfferSelectionTranslation,
    SELECTION_TRANSLATION_MAX_CHARS,
  } = loadContentHelpers();

  assert.equal(normalizeSelectedText("  Hello\nworld  "), "Hello world");
  assert.equal(isMostlyChineseSelection("这是中文句子。"), true);
  assert.equal(isMostlyChineseSelection("Selected English caption"), false);
  assert.equal(
    shouldOfferSelectionTranslation("Hello from the description"),
    true,
  );
  assert.equal(shouldOfferSelectionTranslation("..."), false);
  assert.equal(
    shouldOfferSelectionTranslation("Hello", { inEditable: true }),
    false,
  );
  assert.equal(
    shouldOfferSelectionTranslation("x".repeat(SELECTION_TRANSLATION_MAX_CHARS + 1)),
    false,
  );
  assert.equal(SELECTION_TRANSLATION_MAX_CHARS, 2000);
});
