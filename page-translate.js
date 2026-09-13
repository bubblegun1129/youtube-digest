/**
 * PAGE TRANSLATE CONTENT SCRIPT
 *
 * Runs on ordinary web pages and translates selected text in a small popup.
 * YouTube-specific UI stays in content.js.
 */

const PAGE_TRANSLATE_MAX_SELECTION_CHARS = 4000;
const PAGE_TRANSLATE_DEBOUNCE_MS = 300;
const PAGE_TRANSLATE_POPUP_ID = "ytd-page-translate-popup";
const PAGE_TRANSLATE_MIN_LETTERS = 2;
const PAGE_TRANSLATE_MAX_CHINESE_LETTER_RATIO = 0.5;
const PAGE_TRANSLATE_TEXT_LETTER_PATTERN =
  /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u052f\u3040-\u30ff\uac00-\ud7af\u3400-\u9fff\uf900-\ufaff]/g;
const PAGE_TRANSLATE_CHINESE_LETTER_PATTERN =
  /[\u3400-\u9fff\uf900-\ufaff]/g;

let pageTranslatePopup = null;
let pageTranslatePopupContent = null;
let pageTranslateRequestId = 0;
// Session-level cache of successful translations: selected text -> translated
// text. Re-selecting the same phrase shows the cached result with zero API
// cost. Failures are intentionally NOT cached so a retry still works.
const pageTranslateCache = new Map();
let pageTranslateDebounceTimer = null;

function isTranslatablePageSelection(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;

  const compact = normalized.replace(/\s+/g, "");
  if (
    /^(?:https?:\/\/|www\.)[^\s]+$/i.test(compact) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(compact)
  ) {
    return false;
  }

  try {
    const url = new URL(compact);
    if (url.protocol === "http:" || url.protocol === "https:") return false;
  } catch (_error) {
    // Non-URL selections continue through the text checks below.
  }

  const withoutUrls = normalized.replace(
    /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi,
    "",
  );
  const letters = withoutUrls.match(PAGE_TRANSLATE_TEXT_LETTER_PATTERN) || [];
  if (letters.length < PAGE_TRANSLATE_MIN_LETTERS) return false;

  // Keep the popup quiet for Chinese selections, but do not block a mostly
  // foreign-language sentence just because the drag captured a little Chinese
  // UI text around it.
  const chineseLetters =
    withoutUrls.match(PAGE_TRANSLATE_CHINESE_LETTER_PATTERN) || [];
  const nonChineseLetterCount = letters.length - chineseLetters.length;
  if (nonChineseLetterCount < PAGE_TRANSLATE_MIN_LETTERS) return false;

  return (
    chineseLetters.length / letters.length <
    PAGE_TRANSLATE_MAX_CHINESE_LETTER_RATIO
  );
}

function getSelectedPageText() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return { text: "", rect: null };
  }

  const text = selection.toString().trim();
  if (!text) return { text: "", rect: null };
  if (!isTranslatablePageSelection(text)) return { text: "", rect: null };

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    return { text: "", rect: null };
  }

  return { text, rect };
}

function ensurePageTranslatePopup() {
  if (pageTranslatePopup?.isConnected) return pageTranslatePopup;

  const host = document.createElement("div");
  host.id = PAGE_TRANSLATE_POPUP_ID;
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  host.style.display = "none";
  host.style.left = "0";
  host.style.top = "0";

  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        color-scheme: light;
      }
      .card {
        box-sizing: border-box;
        width: min(340px, calc(100vw - 24px));
        max-height: min(260px, calc(100vh - 24px));
        overflow: auto;
        padding: 12px 14px;
        border: 1px solid rgba(43, 38, 32, 0.14);
        border-radius: 10px;
        background: #fffaf3;
        color: #2f2a24;
        box-shadow: 0 14px 34px rgba(31, 27, 22, 0.22);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 14px;
        line-height: 1.55;
      }
      .status {
        color: #7a7066;
        font-size: 13px;
      }
      .error {
        color: #b0442e;
        font-size: 13px;
      }
      .text {
        white-space: pre-wrap;
      }
    </style>
    <div class="card" role="status" aria-live="polite">
      <div class="status" id="content">Translating...</div>
    </div>
  `;

  pageTranslatePopup = host;
  pageTranslatePopupContent = shadow.getElementById("content");
  document.documentElement.appendChild(host);
  host.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return host;
}

function positionPageTranslatePopup(rect) {
  const popup = ensurePageTranslatePopup();
  popup.style.display = "block";

  const margin = 12;
  const desiredTop = rect.bottom + 8;
  const desiredLeft = rect.left + rect.width / 2 - 170;
  const maxLeft = window.innerWidth - 340 - margin;
  const left = Math.max(margin, Math.min(desiredLeft, Math.max(margin, maxLeft)));
  const top = Math.max(
    margin,
    Math.min(desiredTop, window.innerHeight - 260 - margin),
  );

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function setPageTranslatePopupContent(text, state = "text") {
  ensurePageTranslatePopup();
  if (!pageTranslatePopupContent) return;
  pageTranslatePopupContent.className = state;
  pageTranslatePopupContent.textContent = text;
}

function hidePageTranslatePopup() {
  pageTranslateRequestId += 1;
  clearTimeout(pageTranslateDebounceTimer);
  pageTranslateDebounceTimer = null;
  if (pageTranslatePopup) pageTranslatePopup.style.display = "none";
}

async function translatePageSelection(text) {
  // chrome.runtime can be briefly unavailable (extension reload, sandboxed
  // contexts, etc.). Without this guard, the raw
  // "Cannot read properties of undefined (reading 'sendMessage')" leaks to
  // the popup and tells the user nothing actionable.
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("Extension context unavailable. Try reloading the page.");
  }

  const result = await chrome.runtime.sendMessage({
    action: "translateContent",
    content: { text },
    contentType: "selectedText",
    targetLanguage: "zh",
    videoTitle: document.title || "Web page",
  });

  if (!result?.success) {
    throw new Error(result?.error || "Translation failed.");
  }

  const translatedText = result.translatedContent?.text?.trim();
  if (!translatedText) {
    throw new Error("Translation returned empty text.");
  }
  return translatedText;
}

function handlePageSelectionMouseup(event) {
  if (pageTranslatePopup?.contains(event.target)) return;

  // Debounce: adjusting a selection or re-grabbing text fires many mouseup
  // events for the same translation need. Collapse them into one request.
  clearTimeout(pageTranslateDebounceTimer);
  pageTranslateDebounceTimer = setTimeout(() => {
    pageTranslateDebounceTimer = null;
    void handlePageSelectionDebounced();
  }, PAGE_TRANSLATE_DEBOUNCE_MS);
}

async function handlePageSelectionDebounced() {
  const { text, rect } = getSelectedPageText();
  if (!text || !rect) {
    hidePageTranslatePopup();
    return;
  }

  const requestId = ++pageTranslateRequestId;
  positionPageTranslatePopup(rect);

  if (text.length > PAGE_TRANSLATE_MAX_SELECTION_CHARS) {
    setPageTranslatePopupContent("Selected text is too long.", "error");
    return;
  }

  // Cache hit: show the previous translation without spending another request.
  const cached = pageTranslateCache.get(text);
  if (cached !== undefined) {
    setPageTranslatePopupContent(cached, "text");
    return;
  }

  setPageTranslatePopupContent("Translating...", "status");
  try {
    const translatedText = await translatePageSelection(text);
    if (requestId !== pageTranslateRequestId) return;
    pageTranslateCache.set(text, translatedText);
    setPageTranslatePopupContent(translatedText, "text");
  } catch (error) {
    if (requestId !== pageTranslateRequestId) return;
    setPageTranslatePopupContent(error.message || "Translation failed.", "error");
  }
}

document.addEventListener("mouseup", handlePageSelectionMouseup);
document.addEventListener("selectionchange", () => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) hidePageTranslatePopup();
});
window.addEventListener("scroll", hidePageTranslatePopup, true);
window.addEventListener("resize", hidePageTranslatePopup);
