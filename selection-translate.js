/**
 * CONTENT SCRIPT — selection translation
 *
 * Runs on ordinary http(s) pages, including YouTube. When the viewer selects
 * text, a floating card translates that selection into Simplified Chinese.
 *
 * This file is separate from content.js so YouTube-only Digest controls are
 * never injected into other websites.
 */

const SELECTION_TRANSLATION_MAX_CHARS = 2000;
const SELECTION_TRANSLATION_HOST_ID = "ytd-selection-translator";
const SELECTION_TRANSLATION_CACHE_LIMIT = 40;

let selectionTranslationHost = null;
let selectionTranslationRoot = null;
let selectionTranslationTimer = null;
let selectionTranslationRequestId = 0;
let selectionTranslationListenersAdded = false;
let selectionTranslationLastText = "";
const selectionTranslationCache = new Map();

function normalizeSelectedText(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function isMostlyChineseSelection(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (compact.length < 2) return false;
  const cjk = (compact.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (compact.match(/[A-Za-z]/g) || []).length;
  return cjk >= 2 && latin < 4 && cjk / compact.length >= 0.6;
}

function nodeToElement(node) {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

function isEditableNode(node) {
  const element = nodeToElement(node);
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(
    element.closest(
      "input, textarea, select, [contenteditable='true'], [contenteditable='']",
    ),
  );
}

function isInsideSelectionTranslator(node) {
  const element = nodeToElement(node);
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(element.closest(`#${SELECTION_TRANSLATION_HOST_ID}`));
}

function shouldOfferSelectionTranslation(text, { inEditable = false } = {}) {
  if (inEditable) return false;
  const normalized = normalizeSelectedText(text);
  if (!normalized) return false;
  if (normalized.length > SELECTION_TRANSLATION_MAX_CHARS) return false;
  return /[A-Za-z0-9\u00C0-\u024F\u3400-\u9fff]/.test(normalized);
}

function rememberSelectionTranslation(sourceText, translatedText) {
  if (selectionTranslationCache.has(sourceText)) {
    selectionTranslationCache.delete(sourceText);
  }
  selectionTranslationCache.set(sourceText, translatedText);
  while (selectionTranslationCache.size > SELECTION_TRANSLATION_CACHE_LIMIT) {
    const oldestKey = selectionTranslationCache.keys().next().value;
    selectionTranslationCache.delete(oldestKey);
  }
}

function getPageTitle() {
  const title = typeof document.title === "string" ? document.title.trim() : "";
  return title.slice(0, 300);
}

function getSelectionTranslatorStyles() {
  return `
    :host {
      all: initial;
      position: absolute;
      z-index: 2147483646;
      pointer-events: none;
    }
    .card {
      pointer-events: auto;
      width: min(340px, calc(100vw - 24px));
      background: #fffdf8;
      color: #2e2a24;
      border: 1px solid #ece5d9;
      border-radius: 14px;
      box-shadow: 0 16px 40px rgba(50, 42, 32, 0.22);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: hidden;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px 8px;
      background: #fbf8f2;
      border-bottom: 1px solid #ece5d9;
    }
    .title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #c8674f;
    }
    .close {
      border: 0;
      background: transparent;
      color: #a39a8d;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      padding: 0 2px;
    }
    .close:hover { color: #c8674f; }
    .source, .result {
      padding: 10px 12px 0;
      font-size: 13px;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .source {
      color: #6b6258;
      max-height: 4.8em;
      overflow: hidden;
    }
    .label {
      display: block;
      margin-bottom: 4px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #a39a8d;
    }
    .result {
      padding-bottom: 10px;
      color: #2e2a24;
      font-size: 14px;
    }
    .result.is-loading, .result.is-error { color: #6b6258; }
    .result.is-error { color: #c8674f; }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 8px 12px 12px;
    }
    .copy {
      border: 0;
      border-radius: 999px;
      background: #c8674f;
      color: #fff;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      padding: 7px 12px;
    }
    .copy:hover { background: #b25742; }
    .copy:disabled {
      background: #ddd4c4;
      cursor: default;
    }
  `;
}

function ensureSelectionTranslator() {
  if (selectionTranslationHost?.isConnected && selectionTranslationRoot) {
    return selectionTranslationRoot;
  }

  if (selectionTranslationHost) {
    selectionTranslationHost.remove();
    selectionTranslationHost = null;
    selectionTranslationRoot = null;
  }
  const host = document.createElement("div");
  host.id = SELECTION_TRANSLATION_HOST_ID;
  host.setAttribute("data-ytd-selection-translator", "true");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${getSelectionTranslatorStyles()}</style>
    <div class="card" role="dialog" aria-label="Chinese translation">
      <div class="header">
        <div class="title">中文翻译</div>
        <button class="close" type="button" aria-label="Close">×</button>
      </div>
      <div class="source">
        <span class="label">Selected</span>
        <span class="source-text"></span>
      </div>
      <div class="result is-loading" aria-live="polite">
        <span class="label">中文</span>
        <span class="result-text">Translating…</span>
      </div>
      <div class="actions">
        <button class="copy" type="button" disabled>Copy</button>
      </div>
    </div>
  `;

  root.querySelector(".close").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    hideSelectionTranslator();
  });
  root.querySelector(".copy").addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  root.querySelector(".copy").addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const translated = root.querySelector(".result-text")?.textContent || "";
    const copyButton = root.querySelector(".copy");
    if (!translated || copyButton.disabled) return;
    try {
      await navigator.clipboard.writeText(translated);
      copyButton.textContent = "Copied";
      setTimeout(() => {
        if (copyButton.textContent === "Copied") copyButton.textContent = "Copy";
      }, 1200);
    } catch (_error) {
      copyButton.textContent = "Copy failed";
    }
  });

  (document.documentElement || document.body).appendChild(host);
  selectionTranslationHost = host;
  selectionTranslationRoot = root;
  return root;
}

function positionSelectionTranslator(range) {
  if (!selectionTranslationHost || !range) return;
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return;

  const popupWidth = Math.min(340, window.innerWidth - 24);
  const left = Math.min(
    Math.max(12, rect.left + rect.width / 2 - popupWidth / 2),
    window.innerWidth - popupWidth - 12,
  );
  const below = rect.bottom + 10;
  const estimatedHeight = 180;
  const top =
    below + estimatedHeight > window.innerHeight - 12
      ? Math.max(12, rect.top - estimatedHeight - 10)
      : below;

  selectionTranslationHost.style.position = "fixed";
  selectionTranslationHost.style.left = `${Math.round(left)}px`;
  selectionTranslationHost.style.top = `${Math.round(top)}px`;
}

function setSelectionTranslatorContent({
  sourceText,
  resultText,
  loading = false,
  error = false,
  copyable = false,
}) {
  const root = ensureSelectionTranslator();
  root.querySelector(".source-text").textContent = sourceText;
  const result = root.querySelector(".result");
  result.classList.toggle("is-loading", loading);
  result.classList.toggle("is-error", error);
  root.querySelector(".result-text").textContent = resultText;
  const copyButton = root.querySelector(".copy");
  copyButton.disabled = !copyable;
  copyButton.textContent = "Copy";
}

function hideSelectionTranslator() {
  selectionTranslationRequestId += 1;
  selectionTranslationLastText = "";
  if (selectionTranslationHost) {
    selectionTranslationHost.remove();
    selectionTranslationHost = null;
    selectionTranslationRoot = null;
  }
}

function getCurrentPageSelection() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  return {
    text: selection.toString(),
    range: selection.getRangeAt(0),
    anchorNode: selection.anchorNode,
    focusNode: selection.focusNode,
  };
}

async function maybeTranslateSelection() {
  const current = getCurrentPageSelection();
  if (!current) {
    hideSelectionTranslator();
    return;
  }

  if (
    isInsideSelectionTranslator(current.anchorNode) ||
    isInsideSelectionTranslator(current.focusNode)
  ) {
    return;
  }

  const inEditable =
    isEditableNode(current.anchorNode) || isEditableNode(current.focusNode);
  const sourceText = normalizeSelectedText(current.text);
  if (!shouldOfferSelectionTranslation(sourceText, { inEditable })) {
    hideSelectionTranslator();
    return;
  }

  if (sourceText === selectionTranslationLastText && selectionTranslationHost) {
    positionSelectionTranslator(current.range);
    return;
  }

  selectionTranslationLastText = sourceText;
  const requestId = ++selectionTranslationRequestId;
  setSelectionTranslatorContent({
    sourceText,
    resultText: isMostlyChineseSelection(sourceText)
      ? "Already Simplified Chinese"
      : "Translating…",
    loading: !isMostlyChineseSelection(sourceText),
    copyable: false,
  });
  positionSelectionTranslator(current.range);

  const cached = selectionTranslationCache.get(sourceText);
  if (cached) {
    setSelectionTranslatorContent({
      sourceText,
      resultText: cached,
      copyable: true,
    });
    return;
  }

  if (isMostlyChineseSelection(sourceText)) {
    rememberSelectionTranslation(sourceText, sourceText);
    setSelectionTranslatorContent({
      sourceText,
      resultText: sourceText,
      copyable: true,
    });
    return;
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "translateSelection",
      selectedText: sourceText,
      pageTitle: getPageTitle(),
    });
    if (requestId !== selectionTranslationRequestId) return;
    if (result?.success && result.text) {
      rememberSelectionTranslation(sourceText, result.text);
      setSelectionTranslatorContent({
        sourceText,
        resultText: result.text,
        copyable: true,
      });
      return;
    }
    setSelectionTranslatorContent({
      sourceText,
      resultText: result?.error || "Translation failed.",
      error: true,
    });
  } catch (error) {
    if (requestId !== selectionTranslationRequestId) return;
    setSelectionTranslatorContent({
      sourceText,
      resultText: error.message || "Translation failed.",
      error: true,
    });
  }
}

function scheduleSelectionTranslation() {
  if (selectionTranslationTimer) clearTimeout(selectionTranslationTimer);
  selectionTranslationTimer = setTimeout(() => {
    selectionTranslationTimer = null;
    maybeTranslateSelection();
  }, 80);
}

function handleSelectionPointerEvent(event) {
  if (isInsideSelectionTranslator(event.target)) return;
  scheduleSelectionTranslation();
}

function handleSelectionKeyEvent(event) {
  if (
    event.key === "Escape" &&
    (selectionTranslationHost || selectionTranslationLastText)
  ) {
    hideSelectionTranslator();
    return;
  }
  if (
    event.key === "Shift" ||
    event.shiftKey ||
    event.key.startsWith("Arrow")
  ) {
    scheduleSelectionTranslation();
  }
}

function handleSelectionOutsidePointer(event) {
  if (isInsideSelectionTranslator(event.target)) return;
  const current = getCurrentPageSelection();
  if (current && shouldOfferSelectionTranslation(current.text)) return;
  hideSelectionTranslator();
}

function setupSelectionTranslation() {
  if (selectionTranslationListenersAdded) return;
  selectionTranslationListenersAdded = true;
  document.addEventListener("mouseup", handleSelectionPointerEvent, true);
  document.addEventListener("keyup", handleSelectionKeyEvent, true);
  document.addEventListener("mousedown", handleSelectionOutsidePointer, true);
  document.addEventListener("scroll", hideSelectionTranslator, true);
  window.addEventListener("popstate", hideSelectionTranslator);
  document.addEventListener("yt-navigate-finish", hideSelectionTranslator);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupSelectionTranslation);
} else {
  setupSelectionTranslation();
}

globalThis.__YTD_SELECTION_TRANSLATION_TESTING__ = {
  normalizeSelectedText,
  isMostlyChineseSelection,
  shouldOfferSelectionTranslation,
  SELECTION_TRANSLATION_MAX_CHARS,
};
