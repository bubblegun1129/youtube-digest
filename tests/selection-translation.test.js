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
      location: { pathname: "/watch" },
      addEventListener() {},
      getComputedStyle: () => ({ display: "flex", visibility: "visible" }),
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage() {
          return { success: true };
        },
      },
    },
    MutationObserver: class {
      observe() {}
    },
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("content.js"), sandbox);
  return sandbox.__YTD_SELECTION_TRANSLATION_TESTING__;
}

test("page selection translation is wired through the content script and background", () => {
  const content = read("content.js");
  const background = read("background.js");
  const sidepanel = read("sidepanel.js");

  assert.match(content, /setupSelectionTranslation\(\)/);
  assert.match(content, /action: "translateSelection"/);
  assert.match(content, /ytd-selection-translator/);
  assert.match(content, /attachShadow\(\{ mode: "open" \}\)/);
  assert.match(background, /message\.action === "translateSelection"/);
  assert.match(background, /async function handleTranslateSelection\(/);
  assert.match(sidepanel, /selection-translation-card/);
  assert.match(sidepanel, /action: "translateSelection"/);
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
