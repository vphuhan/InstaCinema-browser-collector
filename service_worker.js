const LOCAL_BACKEND = "http://127.0.0.1:8000/browser-capture";

// Found in the installed aiograpi collection implementation.
const KNOWN_ENDPOINT_PATTERNS = [
  "/api/v1/collections/list/",
  "/api/v1/feed/collection/",
  "/api/v1/feed/saved/posts/",
];

// Add browser-specific patterns here after confirming them in DevTools.
const PLACEHOLDER_ENDPOINT_PATTERNS = [
  // "/api/v1/PLACEHOLDER_COLLECTION_ENDPOINT",
];

// Keep this enabled while discovering the browser's actual endpoint names.
// Metadata is logged locally; response bodies are still captured only for
// matching patterns above.
const DISCOVERY_MODE = true;

let activeTabId = null;
let running = false;
let scrollTimer = null;
let scrollInFlight = false;
let matchingResponseCount = 0;
let noResponseAttempts = 0;
let morePagesAvailable = null;
let cursorRequestFailures = 0;
let currentCollectionName = "Collection";
let localBackendUnavailable = false;
const pendingResponseBodies = new Map();
const captureTasks = new Set();
const requestedPageUrls = new Set();
const requestHeadersById = new Map();
const capturedPageKeys = new Set();
const capturedPostIds = new Set();
const RESPONSE_WAIT_MS = 900;
const MAX_NO_RESPONSE_ATTEMPTS = 8;
const CAPTURE_STORAGE_KEY = "capturedResponses";
const LOG_STORAGE_KEY = "collectorLog";

function pageKey(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}?${parsed.searchParams.toString()}`;
}

function endpointMatches(url) {
  return [...KNOWN_ENDPOINT_PATTERNS, ...PLACEHOLDER_ENDPOINT_PATTERNS]
    .some((pattern) => url.includes(pattern));
}

function sendStatus(message) {
  const displayMessage = `${message} · Items fetched: ${capturedPostIds.size}`;
  chrome.runtime.sendMessage({type: "status", message: displayMessage}).catch(() => {});
  appendLog("status", {message});
  if (activeTabId !== null && running) {
    setPageOverlay(displayMessage, true).catch((error) => {
      console.warn("Could not update page status overlay", error);
    });
  }
}

function countPageItems(body) {
  const page = body?.save_media_response || body;
  if (page?.collection_name) currentCollectionName = page.collection_name;
  for (const item of page?.items || []) {
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

async function appendLog(event, details = {}) {
  const stored = await chrome.storage.local.get({[LOG_STORAGE_KEY]: []});
  stored[LOG_STORAGE_KEY].push({timestamp: new Date().toISOString(), event, ...details});
  await chrome.storage.local.set({[LOG_STORAGE_KEY]: stored[LOG_STORAGE_KEY]});
}

async function setPageOverlay(message, visible) {
  if (activeTabId === null) return;
  const encodedMessage = JSON.stringify(String(message));
  await chrome.debugger.sendCommand({tabId: activeTabId}, "Runtime.evaluate", {
    expression: `(() => {
      const id = '__instacinema_collector_overlay__';
      let overlay = document.getElementById(id);
      if (!${visible}) { overlay?.remove(); return; }
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = id;
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:wait;background:rgba(0,0,0,.38);pointer-events:auto;';
        document.documentElement.appendChild(overlay);
      }
      overlay.innerHTML = '<div style="position:fixed;left:18px;bottom:18px;padding:10px 14px;border-radius:10px;color:#fff;background:rgba(24,20,38,.94);font:13px system-ui,sans-serif;">🎬 InstaCinema<br><span></span></div>';
      overlay.querySelector('span').textContent = ${encodedMessage};
    })()`,
  });
}

async function getPageMetrics() {
  const result = await chrome.debugger.sendCommand(
    {tabId: activeTabId},
    "Runtime.evaluate",
    {
      expression: `(() => {
        const root = document.scrollingElement || document.documentElement;
        const height = Math.max(root.scrollHeight, document.body?.scrollHeight || 0);
        const viewport = window.innerHeight;
        const scrollY = window.scrollY || root.scrollTop || 0;
        const loadingSelector = [
          '[role="progressbar"]',
          '[aria-label*="Loading" i]',
          '[aria-label*="加载" i]',
          '[data-testid*="loading" i]',
        ].join(',');
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

async function scrollToLoadingIndicator() {
  const result = await chrome.debugger.sendCommand(
    {tabId: activeTabId},
    "Runtime.evaluate",
    {
      expression: `(() => {
        const selector = [
          '[role="progressbar"]',
          '[aria-label*="Loading" i]',
          '[aria-label*="加载" i]',
          '[data-testid*="loading" i]',
        ].join(',');
        const element = [...document.querySelectorAll(selector)].find((candidate) => {
          const style = getComputedStyle(candidate);
          const box = candidate.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden'
            && box.width > 0 && box.height > 0;
        });
        if (!element) return false;
        element.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'auto'});
        return true;
      })()`,
      returnByValue: true,
    },
  );
  return result?.result?.value === true;
}

async function requestNextPage(url, nextMaxId, originalHeaders = {}) {
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
      noResponseAttempts = 0;
      morePagesAvailable = page.more_available === undefined
        ? morePagesAvailable
        : Boolean(page.more_available);
      const payload = {
        source: "instagram-browser",
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
      await storeCapture(payload);
      await sendToLocalBackend(payload);
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

async function sendToLocalBackend(payload) {
  if (localBackendUnavailable) return false;
  try {
    const response = await fetch(LOCAL_BACKEND, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Backend returned HTTP ${response.status}`);
    }
    return true;
  } catch (error) {
    console.warn("InstaCinema local backend forwarding failed", error);
    localBackendUnavailable = true;
    sendStatus(`Saved locally; optional backend unavailable (${error.message}).`);
    return false;
  }
}

async function storeCapture(payload) {
  const stored = await chrome.storage.local.get({[CAPTURE_STORAGE_KEY]: []});
  const captures = stored[CAPTURE_STORAGE_KEY];
  captures.push(payload);
  await chrome.storage.local.set({[CAPTURE_STORAGE_KEY]: captures});
}

async function captureResponseBody(requestId, metadata) {
  try {
    const result = await chrome.debugger.sendCommand(
      {tabId: activeTabId},
      "Network.getResponseBody",
      {requestId},
    );
    let body = result.body;
    if (metadata.mimeType.includes("json")) {
      try {
        body = JSON.parse(body);
      } catch {
        // Keep the raw body when the endpoint labels invalid/non-JSON content.
      }
    }
    if (body && typeof body === "object") {
      const page = body.save_media_response || body;
      countPageItems(body);
      if ("more_available" in page) {
        morePagesAvailable = Boolean(page.more_available);
      }
      if (page.more_available && page.next_max_id) {
        await requestNextPage(metadata.url, page.next_max_id, metadata.requestHeaders);
      }
    }
    const payload = {
      source: "instagram-browser",
      tab_url: metadata.tabUrl,
      request_url: metadata.url,
      request_id: requestId,
      status: metadata.status,
      mime_type: metadata.mimeType,
      body,
    };
    const key = pageKey(metadata.url);
    if (capturedPageKeys.has(key)) return;
    capturedPageKeys.add(key);
    await appendLog("response_captured", {
      requestUrl: metadata.url,
      itemCount: body?.items?.length || body?.save_media_response?.items?.length || 0,
    });
    await storeCapture(payload);
    await sendToLocalBackend(payload);
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
    if (endpointMatches(params.request?.url || "")) {
      requestHeadersById.set(params.requestId, params.request.headers || {});
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
    if (responseUrl.pathname.includes("/all/") || responseUrl.searchParams.get("max_id")) {
      return;
    }
  } catch {
    return;
  }
  if (DISCOVERY_MODE) {
    console.info("InstaCinema network discovery", {
      type: params.type,
      url: response.url,
      status: response.status,
      mimeType: response.mimeType,
    });
  }
  if (!endpointMatches(response.url)) {
    return;
  }
  matchingResponseCount += 1;
  pendingResponseBodies.set(params.requestId, {
    tabUrl: response.url,
    url: response.url,
    status: response.status,
    mimeType: response.mimeType || "",
    requestHeaders: requestHeadersById.get(params.requestId) || {},
  });
  requestHeadersById.delete(params.requestId);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === activeTabId) {
    running = false;
    activeTabId = null;
    clearInterval(scrollTimer);
    scrollTimer = null;
    sendStatus(`Debugger detached: ${reason}`);
  }
});

async function start(tab) {
  if (!tab?.id || !tab.url?.includes("instagram.com")) {
    return {message: "Open Instagram in the active tab first.", running: false};
  }
  if (running) {
    return {message: "Collection is already running.", running: true};
  }
  activeTabId = tab.id;
  try {
    await chrome.debugger.attach({tabId: activeTabId}, "1.3");
    await chrome.debugger.sendCommand({tabId: activeTabId}, "Network.enable");
  } catch (error) {
    activeTabId = null;
    return {message: `Could not attach debugger: ${error.message}`, running: false};
  }
  running = true;
  scrollInFlight = false;
  matchingResponseCount = 0;
  noResponseAttempts = 0;
  morePagesAvailable = null;
  cursorRequestFailures = 0;
  currentCollectionName = collectionNameFromUrl(tab.url);
  localBackendUnavailable = false;
  pendingResponseBodies.clear();
  requestHeadersById.clear();
  requestedPageUrls.clear();
  capturedPageKeys.clear();
  capturedPostIds.clear();
  await chrome.storage.local.set({[CAPTURE_STORAGE_KEY]: []});
  await chrome.storage.local.set({[LOG_STORAGE_KEY]: []});
  await appendLog("run_started", {tabId: activeTabId, url: tab.url});
  await setPageOverlay("Collecting posts…", true);
  sendStatus("Capturing responses and following pagination cursors.");
  // The initial collection request may have happened before the debugger was
  // attached. Reload so that request is emitted while Network capture is on.
  await chrome.tabs.reload(activeTabId);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  if (running) {
    await setPageOverlay("Collecting posts…", true);
  }
  requestScroll();
  return {message: "Started.", running: true};
}

async function requestScroll() {
  if (!running || activeTabId === null || scrollInFlight) {
    return;
  }
  scrollInFlight = true;
  const responsesBeforeGesture = matchingResponseCount;
  try {
    // Pagination is driven by next_max_id from the captured response.
    // Use a real gesture only when cursor pagination has failed.
    if (cursorRequestFailures > 0) {
      await chrome.debugger.sendCommand(
        {tabId: activeTabId},
        "Input.synthesizeScrollGesture",
        {x: 100, y: 150, yDistance: -3000, speed: 25000, gestureSourceType: "mouse"},
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RESPONSE_WAIT_MS));
    await waitForCaptureTasks();
    if (morePagesAvailable === false) {
      sendStatus("Instagram reported no more pages; finishing capture.");
      await stop();
      return;
    }
    if (morePagesAvailable === true && cursorRequestFailures === 0) {
      // Cursor pagination is active; do not apply the fallback timeout while
      // its next-page requests are still being processed.
      noResponseAttempts = 0;
    } else {
      if (matchingResponseCount === responsesBeforeGesture) {
        noResponseAttempts += 1;
      } else {
        noResponseAttempts = 0;
      }
      if (noResponseAttempts >= MAX_NO_RESPONSE_ATTEMPTS) {
        sendStatus("No matching next-page response appeared; stopping.");
        await stop();
      }
    }
  } catch (error) {
    console.warn("Scroll request failed", error);
  } finally {
    scrollInFlight = false;
    if (running) {
      scrollTimer = setTimeout(requestScroll, 250);
    }
  }
}

async function stop() {
  if (!running || activeTabId === null) {
    return {message: "Collection is not running.", running: false};
  }
  clearInterval(scrollTimer);
  clearTimeout(scrollTimer);
  scrollTimer = null;
  // Let Network.loadingFinished handlers finish reading and storing the last body.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await waitForCaptureTasksWithTimeout();
  running = false;
  scrollInFlight = false;
  noResponseAttempts = 0;
  morePagesAvailable = null;
  cursorRequestFailures = 0;
  pendingResponseBodies.clear();
  requestHeadersById.clear();
  requestedPageUrls.clear();
  capturedPageKeys.clear();
  const tabId = activeTabId;
  try {
    await setPageOverlay("", false);
  } catch (error) {
    console.warn("Could not remove page overlay", error);
  }
  activeTabId = null;
  try {
    await chrome.debugger.detach({tabId});
  } catch (error) {
    console.warn("Debugger detach failed", error);
  }
  try {
    await exportCaptures();
    await appendLog("run_finished");
  } catch (error) {
    console.warn("Automatic capture export failed", error);
    sendStatus(`Stopped, but automatic export failed: ${error.message}`);
    return {message: "Stopped, but export failed.", running: false};
  }
  sendStatus("Stopped and saved captures to Downloads.");
  return {message: "Stopped and saved captures.", running: false};
}

chrome.action.onClicked.addListener(async (tab) => {
  if (running) {
    await stop();
  } else {
    await start(tab);
  }
});

async function exportCaptures() {
  const stored = await chrome.storage.local.get({[CAPTURE_STORAGE_KEY]: []});
  const data = JSON.stringify(stored[CAPTURE_STORAGE_KEY], null, 2);
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(data)}`;
  const safeName = currentCollectionName.replace(/[^a-z0-9 _-]/gi, "_").trim() || "Collection";
  const timestamp = formatLocalTimestamp().replace(/:/g, "-");
  await chrome.downloads.download({
    url,
    filename: `Instagram - ${safeName} (${timestamp}).json`,
    saveAs: false,
  });
  return {message: `Exported ${stored[CAPTURE_STORAGE_KEY].length} captures.`};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "start") {
    chrome.tabs.query({active: true, currentWindow: true}).then(([tab]) => start(tab))
      .then(sendResponse);
    return true;
  }
  if (message.type === "stop") {
    stop().then(sendResponse);
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
