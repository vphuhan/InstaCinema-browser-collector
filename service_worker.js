import {normalizeCapture, normalizedCollectionToCsv} from "./normalizer.js";
import {
  DEFAULT_SETTINGS,
  LOCAL_BACKEND_PERMISSION,
  OUTBOX_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
} from "./settings.js";

const LOCAL_BACKEND = "http://127.0.0.1:8000";

// Capture Instagram's current saved-collection GraphQL response and retain the
// legacy collection /posts/ endpoint as a fallback. /all/ is ignored.
const COLLECTION_POSTS_ENDPOINT = /^\/api\/v1\/feed\/collection\/\d+\/posts\/$/;
const COLLECTION_GRAPHQL_ENDPOINT = "/api/graphql";
// Normal collector mode captures response bodies, forwards them to the local
// API when available, and exports the completed collection to Downloads.
const SCROLL_ONLY_MODE = false;
// Set to false to rely on Instagram's normal infinite-scroll loading.
const USE_CURSOR_REQUESTS = false;

// Add browser-specific patterns here after confirming them in DevTools.
const PLACEHOLDER_ENDPOINT_PATTERNS = [
  // "/api/v1/PLACEHOLDER_COLLECTION_ENDPOINT",
];

// Keep this enabled while discovering the browser's actual endpoint names.
// Metadata is logged locally; response bodies are still captured only for
// matching patterns above.
const DISCOVERY_MODE = false;

let activeTabId = null;
let running = false;
let scrollTimer = null;
let scrollInFlight = false;
let pausedForHiddenTab = false;
let scrollStepCount = 0;
let matchingResponseCount = 0;
let validatedCollectionResponseCount = 0;
let processedPageCount = 0;
let morePagesAvailable = null;
let cursorRequestFailures = 0;
let currentCaptureMethod = "automatic";
let graphQLRequestTemplate = null;
let paginationCursor = null;
let forceDirectFallbackForTest = false;
let fallbackNotificationId = null;
let currentCollectionName = "Collection";
let currentCollectionPk = null;
let currentRunId = null;
let currentStartedAt = null;
const pendingResponseBodies = new Map();
const captureTasks = new Set();
const requestedPageUrls = new Set();
const requestHeadersById = new Map();
const targetRequestsById = new Map();
const capturedPageKeys = new Set();
const capturedPostIds = new Set();
let logWriteChain = Promise.resolve();
let outboxWriteChain = Promise.resolve();
let outboxPumpRunning = false;
const activeOutboxRequests = new Set();
const PAGE_RESPONSE_TIMEOUT_MS = 15000;
const LOADING_INDICATOR_WAIT_MS = 2500;
const INITIAL_LOADING_INDICATOR_WAIT_MS = 20000;
const SCROLL_LOAD_TIMEOUT_MS = 10000;
const CAPTURE_STORAGE_KEY = "capturedResponses";
const LOG_STORAGE_KEY = "collectorLog";
const LAST_RUN_STORAGE_KEY = "lastRunSummary";
const OUTBOX_ALARM = "instacinema-outbox-retry";
const MAX_OUTBOX_CONCURRENCY = 3;
const BACKEND_REQUEST_TIMEOUT_MS = 15000;
let currentStatusMessage = "Open a saved collection to begin.";

async function userSettings() {
  const stored = await chrome.storage.local.get({
    [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS,
  });
  return {...DEFAULT_SETTINGS, ...stored[SETTINGS_STORAGE_KEY]};
}

async function ingestionIsEnabled() {
  const settings = await userSettings();
  if (!settings.ingestion_enabled) return false;
  return chrome.permissions.contains({origins: [LOCAL_BACKEND_PERMISSION]});
}

function pageKey(url, postData = "", body = null) {
  const parsed = new URL(url);
  if (isGraphQLUrl(url)) {
    if (postData) {
      const form = new URLSearchParams(postData);
      return `${parsed.origin}${parsed.pathname}?doc_id=${form.get("doc_id") || ""}`
        + `&variables=${form.get("variables") || ""}`;
    }
    const collection = graphQLCollection(body);
    const details = pageDetails(body);
    const firstItemId = details.items[0]?.pk || details.items[0]?.id || "empty";
    return `${parsed.origin}${parsed.pathname}?collection_id=${collection?.id || ""}`
      + `&end_cursor=${details.nextCursor || ""}&first_item=${firstItemId}`;
  }
  return `${parsed.origin}${parsed.pathname}?${parsed.searchParams.toString()}`;
}

function endpointMatches(url) {
  try {
    const pathname = new URL(url).pathname;
    return COLLECTION_POSTS_ENDPOINT.test(pathname)
      || PLACEHOLDER_ENDPOINT_PATTERNS.some((pattern) => url.includes(pattern));
  } catch {
    return false;
  }
}

function isGraphQLUrl(url) {
  try {
    return new URL(url).pathname.replace(/\/$/, "") === COLLECTION_GRAPHQL_ENDPOINT;
  } catch {
    return false;
  }
}

function requestMatches(request) {
  if (endpointMatches(request?.url || "")) return true;
  // Chrome/Brave does not consistently expose x-fb-friendly-name or POST data
  // in requestWillBeSent. Observe GraphQL responses, then reject unrelated
  // bodies after decoding them.
  return isGraphQLUrl(request?.url || "");
}

function findGraphQLConnection(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value.edges) && value.page_info && typeof value.page_info === "object") {
    return value;
  }
  for (const child of Object.values(value)) {
    const connection = findGraphQLConnection(child);
    if (connection) return connection;
  }
  return null;
}

function graphQLCollection(body) {
  const collection = body?.data?.fetch__MediaCollection;
  return collection && typeof collection === "object" ? collection : null;
}

function pageDetails(body) {
  const legacyPage = body?.save_media_response || body;
  if (Array.isArray(legacyPage?.items)) {
    return {
      items: legacyPage.items,
      moreAvailable: legacyPage.more_available,
      nextCursor: legacyPage.next_max_id || null,
    };
  }
  const collection = graphQLCollection(body);
  const connection = collection?.media || findGraphQLConnection(body);
  if (!connection) return {items: [], moreAvailable: undefined, nextCursor: null};
  return {
    items: connection.edges.map((edge) => edge?.node?.media || edge?.node).filter(Boolean),
    moreAvailable: connection.page_info.has_next_page,
    nextCursor: connection.page_info.end_cursor || null,
  };
}

function sendStatus(message) {
  currentStatusMessage = message;
  const progress = SCROLL_ONLY_MODE
    ? `Scroll steps: ${scrollStepCount}`
    : `Items fetched: ${capturedPostIds.size}`;
  const displayMessage = `${message} · ${progress}`;
  chrome.runtime.sendMessage({type: "status", message: displayMessage}).catch(() => {});
  appendLog("status", {message});
  if (activeTabId !== null && running) {
    setPageOverlay(displayMessage, true).catch((error) => {
      console.warn("Could not update page status overlay", error);
    });
  }
}

async function runScrollOnlyPageOperation(operation, payload = {}) {
  const results = await chrome.scripting.executeScript({
    target: {tabId: activeTabId},
    func: (name, data) => {
      const loadingSelector = '[data-visualcompletion="loading-state"][role="progressbar"]';
      const visibleLoadingIndicators = () => [...document.querySelectorAll(loadingSelector)]
        .map((element) => ({element, box: element.getBoundingClientRect()}))
        .filter(({element, box}) => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden'
            && box.width > 0 && box.height > 0;
        });

      if (name === "set-overlay") {
        const id = '__instacinema_collector_overlay__';
        let overlay = document.getElementById(id);
        if (!data.visible) {
          overlay?.remove();
          return null;
        }
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = id;
          overlay.tabIndex = 0;
          overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:wait;background:rgba(0,0,0,.38);pointer-events:auto;overscroll-behavior:contain;';
          const blockInput = (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
          };
          for (const eventName of ['click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu', 'wheel', 'touchmove', 'keydown', 'keyup']) {
            overlay.addEventListener(eventName, blockInput, {capture: true, passive: false});
          }
          document.documentElement.appendChild(overlay);
          overlay.focus({preventScroll: true});
        }
        overlay.innerHTML = '<div style="position:fixed;left:18px;bottom:18px;padding:10px 14px;border-radius:10px;color:#fff;background:rgba(24,20,38,.94);font:13px system-ui,sans-serif;">📚 StashTable<br><span></span></div>';
        overlay.querySelector('span').textContent = String(data.message);
        return null;
      }

      const root = document.scrollingElement || document.documentElement;
      if (name === "metrics") {
        const height = Math.max(root.scrollHeight, document.body?.scrollHeight || 0);
        const viewport = window.innerHeight;
        const scrollY = window.scrollY || root.scrollTop || 0;
        return {
          scrollY,
          height,
          viewport,
          atBottom: scrollY + viewport >= height - 4,
          loading: visibleLoadingIndicators().length > 0,
          itemCount: document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length,
        };
      }

      if (name === "scroll-to-loading-indicator") {
        const candidates = visibleLoadingIndicators()
          .sort((left, right) => right.box.bottom - left.box.bottom);
        if (!candidates.length) return null;
        const {box} = candidates[0];
        const beforeY = window.scrollY || root.scrollTop || 0;
        const maxY = Math.max(0, root.scrollHeight - window.innerHeight);
        const targetY = Math.min(maxY, Math.max(0, beforeY + box.bottom - window.innerHeight + 24));
        window.scrollTo({top: targetY, behavior: 'auto'});
        return {
          beforeY,
          targetY,
          indicatorTop: beforeY + box.top,
          indicatorBottom: beforeY + box.bottom,
          candidateCount: candidates.length,
        };
      }

      if (name === "scroll-to-current-bottom") {
        const beforeY = window.scrollY || root.scrollTop || 0;
        const targetY = Math.max(0, root.scrollHeight - window.innerHeight);
        window.scrollTo({top: targetY, behavior: 'auto'});
        return {beforeY, targetY, height: root.scrollHeight};
      }

      throw new Error(`Unknown scroll-only page operation: ${name}`);
    },
    args: [operation, payload],
  });
  return results?.[0]?.result ?? null;
}

function countPageItems(body) {
  const legacyPage = body?.save_media_response || body;
  const graphqlName = graphQLCollection(body)?.name;
  if (graphqlName) currentCollectionName = graphqlName;
  else if (legacyPage?.collection_name) currentCollectionName = legacyPage.collection_name;
  for (const item of pageDetails(body).items) {
    const media = item?.media || item;
    const id = media?.pk || media?.id;
    if (id !== undefined && id !== null) capturedPostIds.add(String(id));
  }
}

function formatLocalTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function collectionNameFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const savedIndex = parts.indexOf("saved");
    if (savedIndex >= 0 && parts[savedIndex + 1]) {
      return decodeURIComponent(parts[savedIndex + 1])
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }
  } catch {
    // Keep the generic fallback when the tab URL is not parseable.
  }
  return "Collection";
}

function collectionIdFromUrl(url) {
  const match = String(url).match(/\/feed\/collection\/(\d+)/);
  return match?.[1] || null;
}

function collectionIdFromSavedUrl(url) {
  return String(url).match(/\/saved\/[^/]+\/(\d+)\/?/)?.[1] || null;
}

function collectionIdFromPostData(postData = "") {
  try {
    const variables = JSON.parse(new URLSearchParams(postData).get("variables") || "{}");
    return variables.collection_id ? String(variables.collection_id) : null;
  } catch {
    return null;
  }
}

function collectionIdFromHeaders(headers = {}) {
  const referer = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "referer",
  )?.[1] || "";
  return String(referer).match(/\/saved\/[^/]+\/(\d+)\//)?.[1] || null;
}

function appendLog(event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    run_id: currentRunId,
    event,
    ...details,
  };
  console.info("StashTable run log", entry);
  logWriteChain = logWriteChain.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get({[LOG_STORAGE_KEY]: []});
    stored[LOG_STORAGE_KEY].push(entry);
    await chrome.storage.local.set({[LOG_STORAGE_KEY]: stored[LOG_STORAGE_KEY]});
  });
  return logWriteChain;
}

function withOutbox(mutator) {
  outboxWriteChain = outboxWriteChain.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get({[OUTBOX_STORAGE_KEY]: []});
    const outbox = stored[OUTBOX_STORAGE_KEY];
    const result = await mutator(outbox);
    await chrome.storage.local.set({[OUTBOX_STORAGE_KEY]: outbox});
    return result;
  });
  return outboxWriteChain;
}

async function addOutboxItem(item) {
  await withOutbox((outbox) => {
    if (!outbox.some((candidate) => candidate.id === item.id)) {
      outbox.push({...item, attempts: 0, next_attempt_at: 0});
    }
  });
  scheduleOutboxPump();
}

async function removeOutboxItem(itemId) {
  await withOutbox((outbox) => {
    const index = outbox.findIndex((item) => item.id === itemId);
    if (index >= 0) outbox.splice(index, 1);
  });
}

async function recordOutboxFailure(itemId, error) {
  await withOutbox((outbox) => {
    const item = outbox.find((candidate) => candidate.id === itemId);
    if (!item) return;
    item.attempts += 1;
    item.last_error = error.message;
    item.permanent_error = Boolean(
      error.status && error.status >= 400 && error.status < 500 && error.status !== 404,
    );
    const backoffSeconds = Math.min(2 ** Math.min(item.attempts, 6), 60);
    item.next_attempt_at = Date.now() + backoffSeconds * 1000;
  });
}

async function backendRequest(path, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${LOCAL_BACKEND}${path}`, {
      ...options,
      headers: {"Content-Type": "application/json", ...(options.headers || {})},
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`Backend HTTP ${response.status}: ${detail.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadOutboxItem(item) {
  if (item.type === "start") {
    return backendRequest("/api/v1/ingestion/runs", {
      method: "POST",
      body: JSON.stringify(item.payload),
    });
  }
  if (item.type === "page") {
    return backendRequest(
      `/api/v1/ingestion/runs/${item.run_id}/pages/${item.page_index}`,
      {method: "PUT", body: JSON.stringify(item.payload)},
    );
  }
  if (item.type === "finish") {
    return backendRequest(`/api/v1/ingestion/runs/${item.run_id}/finish`, {
      method: "POST",
      body: JSON.stringify(item.payload),
    });
  }
  throw new Error(`Unknown outbox item type: ${item.type}`);
}

function outboxItemIsEligible(item, outbox) {
  if (item.permanent_error || item.next_attempt_at > Date.now()) return false;
  if (activeOutboxRequests.has(item.id)) return false;
  if (item.type === "start") return true;
  if (outbox.some((candidate) => (
    candidate.run_id === item.run_id && candidate.type === "start"
  ))) return false;
  if (item.type === "finish" && outbox.some((candidate) => (
    candidate.run_id === item.run_id && candidate.type === "page"
  ))) return false;
  return true;
}

function formatBadgeItemCount(count) {
  if (count < 1000) return String(count);
  if (count < 10000) return `${Math.floor(count / 100) / 10}K`;
  if (count < 1000000) return `${Math.floor(count / 1000)}K`;
  if (count < 10000000) return `${Math.floor(count / 100000) / 10}M`;
  if (count < 100000000) return `${Math.floor(count / 1000000)}M`;
  return "99M+";
}

function capturedItemCount(captures) {
  const itemKeys = new Set();
  for (const [pageIndex, capture] of captures.entries()) {
    for (const [itemIndex, item] of pageDetails(capture?.body).items.entries()) {
      const media = item?.media || item;
      const id = media?.pk || media?.id;
      itemKeys.add(id === undefined || id === null
        ? `${pageIndex}:${itemIndex}`
        : String(id));
    }
  }
  return itemKeys.size;
}

async function updateOutboxBadge() {
  const stored = await chrome.storage.local.get({
    [OUTBOX_STORAGE_KEY]: [],
    [CAPTURE_STORAGE_KEY]: [],
  });
  const outbox = stored[OUTBOX_STORAGE_KEY];
  const itemCount = running
    ? capturedPostIds.size
    : capturedItemCount(stored[CAPTURE_STORAGE_KEY]);
  const failed = outbox.filter((item) => item.permanent_error).length;
  const ingestionEnabled = await ingestionIsEnabled();
  if (running && pausedForHiddenTab) {
    await chrome.action.setBadgeBackgroundColor({color: "#b54708"});
    await chrome.action.setBadgeText({text: "TAB"});
  } else if (ingestionEnabled && failed) {
    await chrome.action.setBadgeBackgroundColor({color: "#b42318"});
    await chrome.action.setBadgeText({text: "!"});
  } else if (ingestionEnabled && outbox.length) {
    await chrome.action.setBadgeBackgroundColor({color: "#6941c6"});
    await chrome.action.setBadgeText({
      text: itemCount ? formatBadgeItemCount(itemCount) : "↑",
    });
  } else if (running) {
    await chrome.action.setBadgeBackgroundColor({color: "#175cd3"});
    await chrome.action.setBadgeText({
      text: itemCount ? formatBadgeItemCount(itemCount) : "RUN",
    });
  } else {
    await chrome.action.setBadgeBackgroundColor({color: "#667085"});
    await chrome.action.setBadgeText({text: "OFF"});
  }
}

function scheduleOutboxPump() {
  setTimeout(() => processOutbox().catch((error) => {
    console.warn("StashTable outbox pump failed", error);
  }), 0);
}

async function processOutbox() {
  if (outboxPumpRunning) return;
  if (!await ingestionIsEnabled()) {
    await updateOutboxBadge();
    return;
  }
  outboxPumpRunning = true;
  try {
    const stored = await chrome.storage.local.get({[OUTBOX_STORAGE_KEY]: []});
    const outbox = stored[OUTBOX_STORAGE_KEY];
    const capacity = MAX_OUTBOX_CONCURRENCY - activeOutboxRequests.size;
    const eligible = outbox
      .filter((item) => outboxItemIsEligible(item, outbox))
      .slice(0, Math.max(0, capacity));
    for (const item of eligible) {
      activeOutboxRequests.add(item.id);
      uploadOutboxItem(item).then(async (result) => {
        await removeOutboxItem(item.id);
        await appendLog("outbox_item_uploaded", {
          outboxType: item.type,
          outboxRunId: item.run_id,
          pageIndex: item.page_index,
          result,
        });
        if (item.type === "finish") {
          chrome.runtime.sendMessage({
            type: "status",
            message: `Cloud save complete for ${item.run_id}.`,
          }).catch(() => {});
        }
      }).catch(async (error) => {
        await recordOutboxFailure(item.id, error);
        console.warn("StashTable outbox upload failed", item.id, error);
      }).finally(async () => {
        activeOutboxRequests.delete(item.id);
        await updateOutboxBadge();
        scheduleOutboxPump();
      });
    }
    await updateOutboxBadge();
  } finally {
    outboxPumpRunning = false;
  }
}

async function queueRunStart() {
  if (!await ingestionIsEnabled()) return;
  await addOutboxItem({
    id: `${currentRunId}:start`,
    type: "start",
    run_id: currentRunId,
    payload: {
      run_id: currentRunId,
      platform: "instagram",
      collector: "instagram-extension",
      collection_pk: currentCollectionPk,
      collection_name: currentCollectionName,
      started_at: currentStartedAt,
    },
  });
}

async function queuePageUpload(page) {
  if (!await ingestionIsEnabled()) return;
  await addOutboxItem({
    id: `${page.run_id}:page:${page.page_index}`,
    type: "page",
    run_id: page.run_id,
    page_index: page.page_index,
    payload: {
      captured_at: page.captured_at,
      request_url: page.request_url,
      response_status: page.status,
      mime_type: page.mime_type || "application/json",
      body: page.body,
    },
  });
}

async function queueRunFinish(summary) {
  if (!await ingestionIsEnabled()) return;
  await addOutboxItem({
    id: `${summary.run_id}:finish`,
    type: "finish",
    run_id: summary.run_id,
    payload: {
      status: summary.capture_status,
      page_count: summary.pages_recorded,
      unique_item_count: summary.unique_items,
      error_message: summary.capture_status === "failed" ? summary.reason : null,
      finished_at: summary.finished_at,
    },
  });
}

async function setPageOverlay(message, visible) {
  if (activeTabId === null) return;
  if (SCROLL_ONLY_MODE) {
    await runScrollOnlyPageOperation("set-overlay", {message: String(message), visible});
    return;
  }
  const encodedMessage = JSON.stringify(String(message));
  await chrome.debugger.sendCommand({tabId: activeTabId}, "Runtime.evaluate", {
    expression: `(() => {
      const id = '__instacinema_collector_overlay__';
      let overlay = document.getElementById(id);
      if (!${visible}) { overlay?.remove(); return; }
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = id;
        overlay.tabIndex = 0;
        // Runtime.evaluate scrolls the document directly, so this layer can
        // safely block the user's pointer and wheel input during capture.
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:wait;background:rgba(0,0,0,.38);pointer-events:auto;overscroll-behavior:contain;';
        const blockInput = (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
        };
        for (const eventName of ['click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu', 'wheel', 'touchmove', 'keydown', 'keyup']) {
          overlay.addEventListener(eventName, blockInput, {capture: true, passive: false});
        }
        document.documentElement.appendChild(overlay);
        overlay.focus({preventScroll: true});
      }
      overlay.innerHTML = '<div style="position:fixed;left:18px;bottom:18px;padding:10px 14px;border-radius:10px;color:#fff;background:rgba(24,20,38,.94);font:13px system-ui,sans-serif;">📚 StashTable<br><span></span></div>';
      overlay.querySelector('span').textContent = ${encodedMessage};
    })()`,
  });
}

async function getPageMetrics() {
  if (SCROLL_ONLY_MODE) return runScrollOnlyPageOperation("metrics");
  const result = await chrome.debugger.sendCommand(
    {tabId: activeTabId},
    "Runtime.evaluate",
    {
      expression: `(() => {
        const root = document.scrollingElement || document.documentElement;
        const height = Math.max(root.scrollHeight, document.body?.scrollHeight || 0);
        const viewport = window.innerHeight;
        const scrollY = window.scrollY || root.scrollTop || 0;
        const loadingSelector = '[data-visualcompletion="loading-state"][role="progressbar"]';
        const loading = [...document.querySelectorAll(loadingSelector)]
          .some((element) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden'
              && box.width > 0 && box.height > 0;
          });
        return {
          scrollY,
          height,
          viewport,
          atBottom: scrollY + viewport >= height - 4,
          loading,
        };
      })()`,
      returnByValue: true,
    },
  );
  return result?.result?.value || null;
}

async function reloadTabAndWaitForCompletion(timeoutMs = INITIAL_LOADING_INDICATOR_WAIT_MS) {
  return new Promise((resolve) => {
    let sawLoading = false;
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(completed);
    };
    const onUpdated = (tabId, changeInfo) => {
      if (tabId !== activeTabId) return;
      if (changeInfo.status === "loading") sawLoading = true;
      if (sawLoading && changeInfo.status === "complete") finish(true);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.reload(activeTabId).catch(() => finish(false));
  });
}

async function scrollToLoadingIndicator() {
  if (SCROLL_ONLY_MODE) {
    return runScrollOnlyPageOperation("scroll-to-loading-indicator");
  }
  const result = await chrome.debugger.sendCommand(
    {tabId: activeTabId},
    "Runtime.evaluate",
    {
      expression: `(() => {
        const selector = '[data-visualcompletion="loading-state"][role="progressbar"]';
        const candidates = [...document.querySelectorAll(selector)]
          .map((element) => ({element, box: element.getBoundingClientRect()}))
          .filter(({element, box}) => {
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden'
              && box.width > 0 && box.height > 0;
          })
          .sort((left, right) => right.box.bottom - left.box.bottom);
        if (!candidates.length) return null;
        const {box} = candidates[0];
        const root = document.scrollingElement || document.documentElement;
        const beforeY = window.scrollY || root.scrollTop || 0;
        const maxY = Math.max(0, root.scrollHeight - window.innerHeight);
        const targetY = Math.min(maxY, Math.max(0, beforeY + box.bottom - window.innerHeight + 24));
        window.scrollTo({top: targetY, behavior: 'auto'});
        return {
          beforeY,
          targetY,
          indicatorTop: beforeY + box.top,
          indicatorBottom: beforeY + box.bottom,
          candidateCount: candidates.length,
        };
      })()`,
      returnByValue: true,
    },
  );
  return result?.result?.value || null;
}

async function waitForLoadingIndicator(timeoutMs = LOADING_INDICATOR_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  do {
    const indicator = await scrollToLoadingIndicator();
    if (indicator) return indicator;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (running && Date.now() < deadline);
  return false;
}

async function scrollToCurrentBottom() {
  if (SCROLL_ONLY_MODE) {
    return runScrollOnlyPageOperation("scroll-to-current-bottom");
  }
  const result = await chrome.debugger.sendCommand(
    {tabId: activeTabId},
    "Runtime.evaluate",
    {
      expression: `(() => {
        const root = document.scrollingElement || document.documentElement;
        const beforeY = window.scrollY || root.scrollTop || 0;
        const targetY = Math.max(0, root.scrollHeight - window.innerHeight);
        window.scrollTo({top: targetY, behavior: 'auto'});
        return {beforeY, targetY, height: root.scrollHeight};
      })()`,
      returnByValue: true,
    },
  );
  return result?.result?.value || null;
}

async function waitForProcessedPage(
  previousCount,
  timeoutMs = PAGE_RESPONSE_TIMEOUT_MS,
  pauseWhenHidden = true,
) {
  const deadline = Date.now() + timeoutMs;
  while (running && Date.now() < deadline) {
    if (processedPageCount > previousCount) return "received";
    if (pauseWhenHidden && !(await collectionPageIsVisible())) return "hidden";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "timeout";
}

function directRequestsEnabled() {
  return currentCaptureMethod === "automatic" || currentCaptureMethod === "requests";
}

function scrollingEnabled() {
  return currentCaptureMethod === "automatic" || currentCaptureMethod === "scroll";
}

function safeReplayHeaders(headers = {}) {
  const allowed = new Set([
    "content-type", "x-asbd-id", "x-csrftoken", "x-fb-friendly-name",
    "x-fb-lsd", "x-ig-app-id", "x-ig-www-claim", "x-requested-with",
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => allowed.has(name.toLowerCase())),
  );
}

function graphQLPostDataWithCursor(postData, cursor) {
  const form = new URLSearchParams(postData);
  const variables = JSON.parse(form.get("variables") || "{}");
  variables.after = cursor;
  form.set("variables", JSON.stringify(variables));
  return form.toString();
}

async function replayGraphQLPage(cursor) {
  if (!graphQLRequestTemplate || !cursor) {
    throw new Error("No observed Instagram GraphQL pagination template is available.");
  }
  const postData = graphQLPostDataWithCursor(graphQLRequestTemplate.postData, cursor);
  const encodedUrl = JSON.stringify(graphQLRequestTemplate.url);
  const encodedHeaders = JSON.stringify(safeReplayHeaders(graphQLRequestTemplate.headers));
  const encodedBody = JSON.stringify(postData);
  await appendLog("graphql_replay_started", {cursor});
  const result = await chrome.debugger.sendCommand({tabId: activeTabId}, "Runtime.evaluate", {
    expression: `(async () => {
      try {
        const response = await fetch(${encodedUrl}, {
          method: 'POST', credentials: 'include', headers: ${encodedHeaders}, body: ${encodedBody},
        });
        await response.text();
        return {ok: response.ok, status: response.status};
      } catch (error) {
        return {ok: false, error: String(error)};
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const outcome = result?.result?.value || {};
  if (!outcome.ok) {
    throw new Error(outcome.error || `Instagram returned HTTP ${outcome.status}`);
  }
  await appendLog("graphql_replay_accepted", {cursor, status: outcome.status});
}

async function focusCollectionTab() {
  if (activeTabId === null) return false;
  try {
    const tab = await chrome.tabs.get(activeTabId);
    if (tab.windowId === undefined) return false;
    await chrome.windows.update(tab.windowId, {focused: true});
    await chrome.tabs.update(activeTabId, {active: true});
    await appendLog("collection_tab_focused_for_fallback");
    return true;
  } catch (error) {
    await appendLog("collection_tab_focus_failed", {error: error.message});
    return false;
  }
}

async function notifyScrollingFallback() {
  fallbackNotificationId = `stashtable-fallback-${currentRunId}`;
  await chrome.notifications.create(fallbackNotificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon.png"),
    title: "StashTable needs the collection tab",
    message: "Direct requests stopped. Click to return to Instagram and continue by scrolling.",
    priority: 2,
    requireInteraction: true,
  });
  await appendLog("scroll_fallback_notification_sent");
}

async function waitForScrollingCatchUp(previousResponses, previousPages) {
  const deadline = Date.now() + PAGE_RESPONSE_TIMEOUT_MS;
  while (running && Date.now() < deadline) {
    if (processedPageCount > previousPages) return "new";
    if (validatedCollectionResponseCount > previousResponses) return "duplicate";
    if (!(await collectionPageIsVisible())) return "hidden";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "timeout";
}

async function catchUpScrollingAfterDirectFailure() {
  if (!running || scrollInFlight) return;
  scrollInFlight = true;
  try {
    while (running) {
      if (await pauseWhileCollectionTabIsHidden()) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      const previousResponses = validatedCollectionResponseCount;
      const previousPages = processedPageCount;
      await scrollToCurrentBottom();
      scrollStepCount += 1;
      sendStatus("Scrolling through pages already captured by direct requests.");
      const result = await waitForScrollingCatchUp(previousResponses, previousPages);
      if (result === "hidden") continue;
      if (result === "duplicate") {
        await appendLog("scroll_fallback_duplicate_page", {step: scrollStepCount});
        continue;
      }
      if (result === "new") {
        await appendLog("scroll_fallback_caught_up", {step: scrollStepCount});
        scrollInFlight = false;
        requestScroll();
        return;
      }
      throw new Error("No collection response appeared while scrolling caught up.");
    }
  } catch (error) {
    if (running) {
      await stop("scroll_fallback_failed", {error: error.message});
    }
  } finally {
    scrollInFlight = false;
  }
}

async function runDirectPagination() {
  if (!running || scrollInFlight) return;
  scrollInFlight = true;
  try {
    while (running && morePagesAvailable !== false) {
      if (forceDirectFallbackForTest) {
        forceDirectFallbackForTest = false;
        throw new Error("Automatic fallback was triggered from Advanced Settings.");
      }
      if (!paginationCursor || !graphQLRequestTemplate) {
        throw new Error("Instagram did not provide a replayable pagination request.");
      }
      const pagesBeforeRequest = processedPageCount;
      const requestedCursor = paginationCursor;
      sendStatus("Requesting the next collection page in the background.");
      await replayGraphQLPage(requestedCursor);
      const pageResult = await waitForProcessedPage(
        pagesBeforeRequest, PAGE_RESPONSE_TIMEOUT_MS, false,
      );
      if (pageResult !== "received") {
        throw new Error("The replayed GraphQL response was not captured.");
      }
      sendStatus(`Page ${processedPageCount} recorded locally.`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (running && morePagesAvailable === false) {
      await stop("instagram_no_more_pages");
    }
  } catch (error) {
    await appendLog("direct_pagination_failed", {error: error.message});
    if (currentCaptureMethod === "automatic" && running) {
      sendStatus("Direct requests stopped. Return to the collection tab to continue scrolling.");
      currentCaptureMethod = "scroll";
      scrollInFlight = false;
      if (!(await collectionPageIsVisible())) {
        await notifyScrollingFallback();
      }
      catchUpScrollingAfterDirectFailure();
      return;
    }
    if (running) {
      sendStatus(`Direct pagination failed: ${error.message}`);
      await stop("direct_pagination_failed", {error: error.message});
    }
  } finally {
    scrollInFlight = false;
  }
}

async function collectionPageIsVisible() {
  if (activeTabId === null) return false;
  try {
    const result = await chrome.debugger.sendCommand(
      {tabId: activeTabId},
      "Runtime.evaluate",
      {
        expression: "document.visibilityState === 'visible'",
        returnByValue: true,
      },
    );
    return result?.result?.value === true;
  } catch {
    return false;
  }
}

async function pauseWhileCollectionTabIsHidden() {
  if (await collectionPageIsVisible()) {
    if (pausedForHiddenTab) {
      pausedForHiddenTab = false;
      await appendLog("capture_resumed_visible_tab");
      sendStatus("Collection tab is visible again; resuming capture.");
      await updateOutboxBadge();
    }
    return false;
  }

  if (!pausedForHiddenTab) {
    pausedForHiddenTab = true;
    await appendLog("capture_paused_hidden_tab");
    sendStatus("Capture paused; return to the Instagram collection tab to continue.");
    await updateOutboxBadge();
  }
  return true;
}

async function waitForCollectionContent(timeoutMs = INITIAL_LOADING_INDICATOR_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (running && Date.now() < deadline) {
    const metrics = await getPageMetrics();
    if ((metrics?.itemCount || 0) > 0) return metrics;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function waitForPageGrowth(initialHeight, timeoutMs = SCROLL_LOAD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (running && Date.now() < deadline) {
    const metrics = await getPageMetrics();
    if (metrics?.height > initialHeight + 10) return metrics;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function waitForStableEnd(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = null;
  let previousHeight = null;
  while (running && Date.now() < deadline) {
    const metrics = await getPageMetrics();
    if (!metrics || metrics.loading || !metrics.atBottom) {
      stableSince = null;
      previousHeight = metrics?.height ?? null;
    } else if (metrics.height !== previousHeight) {
      previousHeight = metrics.height;
      stableSince = Date.now();
    } else {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 2000) return metrics;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function requestNextPage(url, nextMaxId, originalHeaders = {}) {
  if (!USE_CURSOR_REQUESTS) return;
  if (!url || !nextMaxId || !url.includes("/api/v1/feed/collection/") || !url.includes("/posts/")) {
    return;
  }
  const nextUrl = new URL(url);
  nextUrl.searchParams.set("max_id", nextMaxId);
  const requestUrl = nextUrl.toString();
  if (requestedPageUrls.has(requestUrl)) return;
  requestedPageUrls.add(requestUrl);
  await appendLog("cursor_request_started", {url: requestUrl});
  const encodedUrl = JSON.stringify(requestUrl);
  const headers = Object.fromEntries(Object.entries(originalHeaders).filter(([name]) => [
    "x-csrftoken", "x-ig-app-id", "x-asbd-id", "x-ig-www-claim", "x-requested-with",
  ].includes(name.toLowerCase())));
  const encodedHeaders = JSON.stringify(headers);
  const result = await chrome.debugger.sendCommand({tabId: activeTabId}, "Runtime.evaluate", {
    expression: `(async () => {
      try {
        const response = await fetch(${encodedUrl}, {credentials: 'include', headers: ${encodedHeaders}});
        const text = await response.text();
        let body = text;
        try { body = JSON.parse(text); } catch {}
        return {ok: response.ok, status: response.status, body};
      } catch (error) {
        return {error: String(error)};
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const outcome = result?.result?.value || {};
  if (outcome.error || !outcome.ok) {
    cursorRequestFailures += 1;
    await appendLog("cursor_request_failed", {url: requestUrl, outcome});
    sendStatus(`Cursor request failed: ${outcome.error || `HTTP ${outcome.status}`}`);
  } else {
    cursorRequestFailures = 0;
    const page = outcome.body?.save_media_response || outcome.body;
    if (page && typeof page === "object") {
      countPageItems(outcome.body);
      matchingResponseCount += 1;
      morePagesAvailable = page.more_available === undefined
        ? morePagesAvailable
        : Boolean(page.more_available);
      const payload = {
        source: "instagram-browser",
        collector: "instagram-extension",
        collection_id: collectionIdFromUrl(requestUrl),
        collection_name: currentCollectionName,
        tab_url: `https://www.instagram.com/`,
        request_url: requestUrl,
        request_id: `cursor-${Date.now()}`,
        status: outcome.status,
        mime_type: "application/json",
        body: outcome.body,
      };
      const key = pageKey(requestUrl);
      if (capturedPageKeys.has(key)) return;
      capturedPageKeys.add(key);
      const pageIndex = processedPageCount;
      await storeCapture(payload, pageIndex);
      processedPageCount += 1;
      await appendLog("response_captured", {
        requestUrl,
        itemCount: page.items?.length || 0,
        via: "page-fetch",
      });
      sendStatus(`Cursor page captured: HTTP ${outcome.status}`);
      if (page.more_available && page.next_max_id) {
        await requestNextPage(requestUrl, page.next_max_id, originalHeaders);
      }
    }
    await appendLog("cursor_request_finished", {url: requestUrl, outcome});
    sendStatus(`Cursor request accepted: HTTP ${outcome.status}`);
  }
}

async function storeCapture(payload, pageIndex) {
  const stored = await chrome.storage.local.get({[CAPTURE_STORAGE_KEY]: []});
  const captures = stored[CAPTURE_STORAGE_KEY];
  const page = {
    ...payload,
    run_id: currentRunId,
    page_index: pageIndex,
    captured_at: new Date().toISOString(),
  };
  captures.push(page);
  await chrome.storage.local.set({[CAPTURE_STORAGE_KEY]: captures});
  // Badge progress belongs to capture, not backend ingestion. Refresh it even
  // when the optional local API outbox is disabled.
  await updateOutboxBadge();
  await queuePageUpload(page);
}

async function captureResponseBody(requestId, metadata) {
  try {
    const result = await chrome.debugger.sendCommand(
      {tabId: activeTabId},
      "Network.getResponseBody",
      {requestId},
    );
    let body = result.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // GraphQL responses are sometimes labelled text/javascript. Keep the
        // raw body only when it is genuinely not JSON.
      }
    }
    if (isGraphQLUrl(metadata.url) && !graphQLCollection(body)) {
      await appendLog("graphql_response_ignored", {
        requestUrl: metadata.url,
        reason: "no_fetch_media_collection",
        topLevelKeys: body && typeof body === "object" ? Object.keys(body) : [],
      });
      return;
    }
    let nextMaxId = null;
    if (body && typeof body === "object") {
      const page = pageDetails(body);
      countPageItems(body);
      if (page.moreAvailable !== undefined) {
        morePagesAvailable = Boolean(page.moreAvailable);
      }
      nextMaxId = page.moreAvailable && page.nextCursor ? page.nextCursor : null;
      paginationCursor = page.moreAvailable ? page.nextCursor : null;
      if (isGraphQLUrl(metadata.url) && metadata.postData) {
        graphQLRequestTemplate = {
          url: metadata.url,
          postData: metadata.postData,
          headers: metadata.requestHeaders,
        };
      }
      console.info("StashTable collection page", {
        url: metadata.url,
        itemCount: page.items.length,
        moreAvailable: page.moreAvailable,
        hasNextCursor: Boolean(page.nextCursor),
      });
    }
    const payload = {
      source: "instagram-browser",
      collector: "instagram-extension",
      collection_id: collectionIdFromUrl(metadata.url)
        || String(graphQLCollection(body)?.id || "")
        || collectionIdFromPostData(metadata.postData)
        || collectionIdFromHeaders(metadata.requestHeaders)
        || null,
      collection_name: currentCollectionName,
      tab_url: metadata.tabUrl,
      request_url: metadata.url,
      request_id: requestId,
      status: metadata.status,
      mime_type: metadata.mimeType,
      body,
    };
    const key = pageKey(metadata.url, metadata.postData, body);
    if (capturedPageKeys.has(key)) {
      validatedCollectionResponseCount += 1;
      return;
    }
    capturedPageKeys.add(key);
    await appendLog("response_captured", {
      requestUrl: metadata.url,
      itemCount: pageDetails(body).items.length,
    });
    const pageIndex = processedPageCount;
    await storeCapture(payload, pageIndex);
    processedPageCount += 1;
    validatedCollectionResponseCount += 1;
    // Raw uploads and normalization are independent of Instagram pagination.
    if (nextMaxId) {
      await requestNextPage(metadata.url, nextMaxId, metadata.requestHeaders);
    }
  } catch (error) {
    console.warn("Could not retrieve response body", requestId, error);
  }
}

async function waitForCaptureTasks() {
  if (captureTasks.size > 0) {
    await Promise.allSettled([...captureTasks]);
  }
}

async function waitForCaptureTasksWithTimeout(timeoutMs = 2000) {
  await Promise.race([
    waitForCaptureTasks(),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!running || source.tabId !== activeTabId) {
    return;
  }
  if (method === "Network.loadingFailed") {
    if (targetRequestsById.has(params.requestId)) {
      appendLog("target_response_failed", {
        requestId: params.requestId,
        errorText: params.errorText,
        canceled: params.canceled,
        blockedReason: params.blockedReason,
      }).catch(() => {});
      targetRequestsById.delete(params.requestId);
      requestHeadersById.delete(params.requestId);
    }
    return;
  }
  if (method === "Network.loadingFinished") {
    const metadata = pendingResponseBodies.get(params.requestId);
    if (metadata) {
      pendingResponseBodies.delete(params.requestId);
      const task = captureResponseBody(params.requestId, metadata);
      captureTasks.add(task);
      task.then(
        () => captureTasks.delete(task),
        () => captureTasks.delete(task),
      );
    }
    return;
  }
  if (method === "Network.requestWillBeSent") {
    if (requestMatches(params.request)) {
      appendLog("target_request_observed", {
        requestId: params.requestId,
        requestUrl: params.request.url,
        isGraphQL: isGraphQLUrl(params.request.url),
        hasPostData: Boolean(params.request.postData),
      }).catch(() => {});
      requestHeadersById.set(params.requestId, params.request.headers || {});
      targetRequestsById.set(params.requestId, {
        postData: params.request.postData || "",
      });
    }
    return;
  }
  if (method !== "Network.responseReceived") {
    return;
  }
  const response = params.response;
  if (!["XHR", "Fetch"].includes(params.type)) {
    return;
  }
  // Cursor pages are fetched and decoded directly in the Instagram tab.
  // Reading them a second time through Network.getResponseBody exhausts
  // Chrome's response buffer on large collections.
  try {
    const responseUrl = new URL(response.url);
    if (USE_CURSOR_REQUESTS
      && (responseUrl.pathname.includes("/all/") || responseUrl.searchParams.get("max_id"))) {
      return;
    }
  } catch {
    return;
  }
  if (DISCOVERY_MODE) {
    let parsedUrl;
    try {
      parsedUrl = new URL(response.url);
    } catch {
      parsedUrl = null;
    }
    console.info("StashTable network discovery", {
      type: params.type,
      url: response.url,
      pathname: parsedUrl?.pathname,
      hasMaxId: Boolean(parsedUrl?.searchParams.get("max_id")),
      status: response.status,
      mimeType: response.mimeType,
    });
  }
  const targetRequest = targetRequestsById.get(params.requestId);
  if (!endpointMatches(response.url) && !isGraphQLUrl(response.url)) {
    return;
  }
  appendLog("target_response_observed", {
    requestId: params.requestId,
    requestUrl: response.url,
    status: response.status,
    mimeType: response.mimeType,
  }).catch(() => {});
  matchingResponseCount += 1;
  pendingResponseBodies.set(params.requestId, {
    tabUrl: response.url,
    url: response.url,
    status: response.status,
    mimeType: response.mimeType || "",
    requestHeaders: requestHeadersById.get(params.requestId) || {},
    postData: targetRequest?.postData || "",
  });
  requestHeadersById.delete(params.requestId);
  targetRequestsById.delete(params.requestId);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === activeTabId) {
    appendLog("debugger_detached", {reason}).catch(() => {});
    running = false;
    activeTabId = null;
    clearInterval(scrollTimer);
    scrollTimer = null;
    sendStatus(`Debugger detached: ${reason}`);
  }
});

async function start(tab) {
  const settings = await userSettings();
  if (!settings.export_json && !settings.export_csv && !settings.export_raw_json) {
    return {message: "Select at least one export format first.", running: false};
  }
  if (!tab?.id || !tab.url?.includes("instagram.com")) {
    return {message: "Open Instagram in the active tab first.", running: false};
  }
  const collectionPk = collectionIdFromSavedUrl(tab.url);
  if (!collectionPk) {
    return {message: "Open a specific Instagram saved collection first.", running: false};
  }
  if (running) {
    return {message: "Collection is already running.", running: true};
  }
  activeTabId = tab.id;
  if (!SCROLL_ONLY_MODE) {
    try {
      await chrome.debugger.attach({tabId: activeTabId}, "1.3");
      await chrome.debugger.sendCommand({tabId: activeTabId}, "Network.enable");
    } catch (error) {
      activeTabId = null;
      return {message: `Could not attach debugger: ${error.message}`, running: false};
    }
  }
  running = true;
  scrollInFlight = false;
  scrollStepCount = 0;
  matchingResponseCount = 0;
  validatedCollectionResponseCount = 0;
  processedPageCount = 0;
  pausedForHiddenTab = false;
  morePagesAvailable = null;
  cursorRequestFailures = 0;
  graphQLRequestTemplate = null;
  paginationCursor = null;
  forceDirectFallbackForTest = false;
  fallbackNotificationId = null;
  currentCollectionName = collectionNameFromUrl(tab.url);
  currentCollectionPk = collectionPk;
  currentRunId = crypto.randomUUID();
  currentStartedAt = new Date().toISOString();
  currentCaptureMethod = settings.capture_method || "scroll";
  pendingResponseBodies.clear();
  requestHeadersById.clear();
  targetRequestsById.clear();
  requestedPageUrls.clear();
  capturedPageKeys.clear();
  capturedPostIds.clear();
  await chrome.storage.local.set({[CAPTURE_STORAGE_KEY]: []});
  await chrome.storage.local.set({[LOG_STORAGE_KEY]: []});
  await chrome.storage.local.remove(LAST_RUN_STORAGE_KEY);
  await appendLog("run_started", {tabId: activeTabId, url: tab.url});
  await queueRunStart();
  await setPageOverlay("Collecting posts…", true);
  if (SCROLL_ONLY_MODE) {
    sendStatus("Scroll-only mode: waiting for Instagram to render.");
    const reloadCompleted = await reloadTabAndWaitForCompletion();
    if (!reloadCompleted) {
      await stop("document_ready_timeout");
      return {message: "Instagram did not finish loading.", running: false};
    }
    const initialContent = await waitForCollectionContent();
    if (!initialContent) {
      await stop("collection_content_timeout");
      return {message: "Instagram did not render the collection posts.", running: false};
    }
    await appendLog("initial_collection_rendered", initialContent);
    await setPageOverlay("Finding the next loading indicator…", true);
    requestScrollOnly();
    return {message: "Scroll-only mode started.", running: true};
  }
  sendStatus(currentCaptureMethod === "scroll"
    ? "Capturing responses with infinite scrolling."
    : "Capturing responses and preparing direct pagination.");
  // The initial collection request may have happened before the debugger was
  // attached. Reload so that request is emitted while Network capture is on.
  await chrome.tabs.reload(activeTabId);
  sendStatus("Waiting for the initial collection response.");
  let initialPageResult = await waitForProcessedPage(0);
  while (running && initialPageResult === "hidden") {
    await pauseWhileCollectionTabIsHidden();
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!(await collectionPageIsVisible())) continue;
    await pauseWhileCollectionTabIsHidden();
    await chrome.tabs.reload(activeTabId);
    sendStatus("Waiting for the initial collection response.");
    initialPageResult = await waitForProcessedPage(0);
  }
  if (!running) {
    return {message: "Stopped.", running: false};
  }
  if (initialPageResult !== "received") {
    sendStatus("The initial collection response did not appear; stopping.");
    await stop("initial_collection_response_timeout");
    return {message: "Initial collection response timed out.", running: false};
  }
  sendStatus("Initial page recorded locally.");
  await setPageOverlay("Collecting posts…", true);
  if (directRequestsEnabled() && graphQLRequestTemplate && paginationCursor) {
    runDirectPagination();
  } else if (scrollingEnabled()) {
    if (currentCaptureMethod === "automatic") {
      await appendLog("direct_pagination_unavailable", {
        reason: "missing_graphql_template_or_cursor",
      });
      currentCaptureMethod = "scroll";
    }
    requestScroll();
  } else if (morePagesAvailable === false) {
    await stop("instagram_no_more_pages");
  } else {
    await stop("direct_pagination_unavailable");
  }
  return {message: "Started.", running: true};
}

async function requestScrollOnly() {
  if (!running || activeTabId === null || scrollInFlight) return;
  scrollInFlight = true;
  try {
    const before = await getPageMetrics();
    const bottomScroll = await scrollToCurrentBottom();
    scrollStepCount += 1;
    await appendLog("scrolled_to_current_bottom", {
      step: scrollStepCount,
      ...bottomScroll,
    });
    sendStatus(`Scrolled to the current bottom; waiting for more posts…`);
    const grownPage = await waitForPageGrowth(before?.height || 0);
    if (!grownPage) {
      const finalMetrics = await waitForStableEnd();
      if (finalMetrics) {
        sendStatus("The page is stable at the bottom; scrolling is complete.");
        await stop("stable_end_at_bottom", finalMetrics);
      } else {
        sendStatus("The page did not grow or settle at the bottom; stopping with an error.");
        await stop("page_growth_timeout", {before, current: await getPageMetrics()});
      }
      return;
    }
    await appendLog("page_height_grew", {
      step: scrollStepCount,
      previousHeight: before?.height,
      currentHeight: grownPage.height,
    });
  } catch (error) {
    console.warn("Scroll-only loop failed", error);
    sendStatus(`Scrolling failed: ${error.message}`);
    await stop("scroll_loop_error", {error: error.message});
    return;
  } finally {
    scrollInFlight = false;
    if (running) scrollTimer = setTimeout(requestScrollOnly, 100);
  }
}

async function requestScroll() {
  if (!running || activeTabId === null || scrollInFlight) {
    return;
  }
  scrollInFlight = true;
  try {
    if (await pauseWhileCollectionTabIsHidden()) return;

    if (morePagesAvailable === false) {
      console.info("StashTable stopping: Instagram reported no more collection pages");
      sendStatus("Instagram reported no more pages; finishing capture.");
      await stop("instagram_no_more_pages");
      return;
    }

    const pagesBeforeScroll = processedPageCount;
    const before = await getPageMetrics();
    const bottomScroll = await scrollToCurrentBottom();
    scrollStepCount += 1;
    await appendLog("scrolled_to_current_bottom", {
      step: scrollStepCount,
      before,
      ...bottomScroll,
    });
    console.info("StashTable scrolled to current bottom", {
      processedPageCount,
      matchingResponseCount,
    });
    sendStatus("Waiting for the next collection response.");
    const pageResult = await waitForProcessedPage(pagesBeforeScroll);
    if (pageResult === "hidden") {
      await pauseWhileCollectionTabIsHidden();
      return;
    }
    if (pageResult !== "received") {
      sendStatus("No collection response appeared after scrolling; stopping.");
      await stop("collection_response_timeout_after_scroll");
      return;
    }
    sendStatus(`Page ${processedPageCount} recorded locally.`);
  } catch (error) {
    console.warn("Collection page loop failed", error);
    sendStatus(`Collection failed: ${error.message}`);
    await stop("collection_loop_error", {error: error.message});
  } finally {
    scrollInFlight = false;
    if (running) {
      scrollTimer = setTimeout(requestScroll, pausedForHiddenTab ? 500 : 100);
    }
  }
}

function captureStatusForReason(reason) {
  if (reason === "instagram_no_more_pages" || reason === "stable_end_at_bottom") {
    return "completed";
  }
  if (reason === "stopped_by_user") return "stopped";
  return "failed";
}

async function stop(reason = "stopped_by_user", details = {}) {
  if (!running || activeTabId === null) {
    return {message: "Collection is not running.", running: false};
  }
  const summary = {
    run_id: currentRunId,
    collection_name: currentCollectionName,
    collection_pk: currentCollectionPk,
    started_at: currentStartedAt,
    reason,
    details,
    pages_recorded: processedPageCount,
    unique_items: capturedPostIds.size,
    capture_status: captureStatusForReason(reason),
    stopped_at: new Date().toISOString(),
  };
  await appendLog("run_stopping", summary);
  await chrome.storage.local.set({[LAST_RUN_STORAGE_KEY]: summary});
  console.info("StashTable stopped", summary);
  clearInterval(scrollTimer);
  clearTimeout(scrollTimer);
  scrollTimer = null;
  if (!SCROLL_ONLY_MODE) {
    await waitForCaptureTasksWithTimeout(250);
  }
  summary.pages_recorded = processedPageCount;
  summary.unique_items = capturedPostIds.size;
  summary.finished_at = new Date().toISOString();
  await chrome.storage.local.set({[LAST_RUN_STORAGE_KEY]: summary});
  await appendLog("run_stopped", summary);
  running = false;
  scrollInFlight = false;
  pausedForHiddenTab = false;
  morePagesAvailable = null;
  cursorRequestFailures = 0;
  graphQLRequestTemplate = null;
  paginationCursor = null;
  forceDirectFallbackForTest = false;
  if (fallbackNotificationId) {
    await chrome.notifications.clear(fallbackNotificationId);
    fallbackNotificationId = null;
  }
  pendingResponseBodies.clear();
  requestHeadersById.clear();
  targetRequestsById.clear();
  requestedPageUrls.clear();
  capturedPageKeys.clear();
  const tabId = activeTabId;
  try {
    await setPageOverlay("", false);
  } catch (error) {
    console.warn("Could not remove page overlay", error);
  }
  activeTabId = null;
  if (!SCROLL_ONLY_MODE) {
    try {
      await chrome.debugger.detach({tabId});
    } catch (error) {
      console.warn("Debugger detach failed", error);
    }
  }
  try {
    if (!SCROLL_ONLY_MODE) await exportCaptures(summary);
    await appendLog("run_finished", summary);
  } catch (error) {
    console.warn("Automatic capture export failed", error);
    sendStatus(`Stopped, but automatic export failed: ${error.message}`);
  }
  await queueRunFinish(summary);
  processedPageCount = 0;
  const ingestionEnabled = await ingestionIsEnabled();
  const message = SCROLL_ONLY_MODE
    ? "Scrolling stopped. No responses were captured."
    : ingestionEnabled
      ? `Exported ${summary.unique_items} items; local API uploads continue in the background.`
      : `Exported ${summary.unique_items} items to Downloads.`;
  sendStatus(message);
  return {message, running: false};
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OUTBOX_ALARM) scheduleOutboxPump();
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!fallbackNotificationId || notificationId !== fallbackNotificationId) return;
  const clickedNotificationId = fallbackNotificationId;
  focusCollectionTab().then(async (focused) => {
    if (focused) {
      sendStatus("Collection tab opened; scrolling fallback is resuming.");
    } else {
      sendStatus("Could not focus the collection tab. Open it manually to continue.");
    }
    await chrome.notifications.clear(clickedNotificationId);
    if (fallbackNotificationId === clickedNotificationId) {
      fallbackNotificationId = null;
    }
  });
});

chrome.runtime.onStartup.addListener(() => scheduleOutboxPump());
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  if (!stored[SETTINGS_STORAGE_KEY]) {
    await chrome.storage.local.set({[SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS});
  }
  chrome.alarms.create(OUTBOX_ALARM, {periodInMinutes: 1});
  scheduleOutboxPump();
});

chrome.alarms.create(OUTBOX_ALARM, {periodInMinutes: 1});
scheduleOutboxPump();

async function exportCaptures(summary = null) {
  const stored = await chrome.storage.local.get({[CAPTURE_STORAGE_KEY]: []});
  const pages = stored[CAPTURE_STORAGE_KEY];
  const settings = await userSettings();
  if (!settings.export_json && !settings.export_csv && !settings.export_raw_json) {
    throw new Error("Select at least one export format.");
  }
  const normalized = normalizeCapture(pages, {
    ...summary,
    collection_name: summary?.collection_name || currentCollectionName,
    collection_pk: summary?.collection_pk || currentCollectionPk,
  });
  const safeName = normalized.collection.name.replace(/[^a-z0-9 _-]/gi, "_").trim()
    || "Collection";
  const timestamp = formatLocalTimestamp().replace(/:/g, "-");
  const basename = `Instagram - ${safeName} (${timestamp})`;
  const downloads = [];
  if (settings.export_json) {
    downloads.push(chrome.downloads.download({
      url: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(normalized, null, 2))}`,
      filename: `${basename}.json`,
      saveAs: false,
    }));
  }
  if (settings.export_csv) {
    downloads.push(chrome.downloads.download({
      url: `data:text/csv;charset=utf-8,${encodeURIComponent(normalizedCollectionToCsv(normalized))}`,
      filename: `${basename}.csv`,
      saveAs: false,
    }));
  }
  if (settings.export_raw_json) {
    const rawCapture = {
      platform: "instagram",
      collection_name: normalized.collection.name,
      collection_pk: normalized.collection.platform_collection_id,
      page_count: pages.length,
      pages: [...pages].sort((left, right) => left.page_index - right.page_index),
    };
    downloads.push(chrome.downloads.download({
      url: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(rawCapture, null, 2))}`,
      filename: `${basename} - Raw pages.json`,
      saveAs: false,
    }));
  }
  await Promise.all(downloads);
  return {
    message: `Exported ${normalized.items.length} items as ${[
      settings.export_json && "JSON",
      settings.export_csv && "CSV",
      settings.export_raw_json && "raw JSON",
    ].filter(Boolean).join(" and ")}.`,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "get-state") {
    sendResponse({
      running,
      item_count: running ? capturedPostIds.size : 0,
      message: currentStatusMessage,
    });
    return false;
  }
  if (message.type === "settings-updated") {
    scheduleOutboxPump();
    updateOutboxBadge().then(() => sendResponse({ok: true}));
    return true;
  }
  if (message.type === "outbox-cleared") {
    updateOutboxBadge().then(() => sendResponse({ok: true}));
    return true;
  }
  if (message.type === "test-automatic-fallback") {
    if (!running || currentCaptureMethod !== "automatic") {
      sendResponse({
        ok: false,
        message: "Start a capture in Automatic fallback mode before running this test.",
      });
      return false;
    }
    forceDirectFallbackForTest = true;
    sendResponse({
      ok: true,
      message: "Fallback test armed. A notification will ask you to return to the collection tab.",
    });
    return false;
  }
  if (message.type === "start") {
    chrome.tabs.query({active: true, currentWindow: true}).then(([tab]) => start(tab))
      .then(sendResponse);
    return true;
  }
  if (message.type === "stop") {
    stop("stopped_by_user").then(sendResponse);
    return true;
  }
  if (message.type === "export") {
    exportCaptures().then(sendResponse).catch((error) => {
      sendResponse({message: `Export failed: ${error.message}`});
    });
    return true;
  }
  return false;
});
