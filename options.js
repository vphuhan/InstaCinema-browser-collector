import {
  DEFAULT_SETTINGS,
  LOCAL_BACKEND_PERMISSION,
  OUTBOX_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
} from "./settings.js";
const ingestionInput = document.querySelector("#ingestion");
const captureMethodInput = document.querySelector("#capture-method");
const captureMethodHelp = document.querySelector("#capture-method-help");
const testFallbackButton = document.querySelector("#test-fallback");
const permissionStatus = document.querySelector("#permission-status");
const pendingCount = document.querySelector("#pending-count");
const clearButton = document.querySelector("#clear-outbox");
const saveStatus = document.querySelector("#save-status");

function showStatus(message, tone = "success") {
  saveStatus.textContent = message;
  saveStatus.className = `setting-status ${tone}`;
}

const CAPTURE_METHOD_HELP = {
  automatic: "Beta. Uses direct requests first, then sends a notification if scrolling needs your attention.",
  scroll: "Uses Instagram's visible page. Keep the collection tab selected during capture.",
  requests: "Beta. Uses observed GraphQL pagination requests and may break when Instagram changes its API.",
};

function renderCaptureMethodHelp() {
  captureMethodHelp.textContent = CAPTURE_METHOD_HELP[captureMethodInput.value];
}

async function load() {
  const stored = await chrome.storage.local.get({
    [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS,
    [OUTBOX_STORAGE_KEY]: [],
  });
  const current = {...DEFAULT_SETTINGS, ...stored[SETTINGS_STORAGE_KEY]};
  const permitted = await chrome.permissions.contains({origins: [LOCAL_BACKEND_PERMISSION]});
  ingestionInput.checked = current.ingestion_enabled && permitted;
  captureMethodInput.value = current.capture_method;
  renderCaptureMethodHelp();
  permissionStatus.textContent = permitted
    ? "Local API access is granted."
    : "Local API access is not granted.";
  pendingCount.textContent = stored[OUTBOX_STORAGE_KEY].length;
  clearButton.disabled = stored[OUTBOX_STORAGE_KEY].length === 0;
}

captureMethodInput.addEventListener("change", async () => {
  const stored = await chrome.storage.local.get({[SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS});
  const current = {...DEFAULT_SETTINGS, ...stored[SETTINGS_STORAGE_KEY]};
  current.capture_method = captureMethodInput.value;
  await chrome.storage.local.set({[SETTINGS_STORAGE_KEY]: current});
  renderCaptureMethodHelp();
  showStatus("Capture mode saved.");
});

testFallbackButton.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({type: "test-automatic-fallback"});
  showStatus(result.message, result.ok ? "api-enabled" : "warning");
});

ingestionInput.addEventListener("change", async () => {
  let granted = false;
  if (ingestionInput.checked) {
    granted = await chrome.permissions.request({origins: [LOCAL_BACKEND_PERMISSION]});
    if (!granted) {
      ingestionInput.checked = false;
      showStatus("Local API access was not granted.", "warning");
      return;
    }
  }
  const stored = await chrome.storage.local.get({[SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS});
  const current = {...DEFAULT_SETTINGS, ...stored[SETTINGS_STORAGE_KEY]};
  if (ingestionInput.checked && granted) {
    current.ingestion_enabled = true;
  } else {
    current.ingestion_enabled = false;
    await chrome.permissions.remove({origins: [LOCAL_BACKEND_PERMISSION]});
  }
  await chrome.storage.local.set({[SETTINGS_STORAGE_KEY]: current});
  await chrome.runtime.sendMessage({type: "settings-updated"});
  showStatus(
    current.ingestion_enabled
      ? "Local API ingestion enabled."
      : "Local API ingestion disabled. Pending uploads were preserved.",
    current.ingestion_enabled ? "api-enabled" : "muted",
  );
  await load();
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.set({[OUTBOX_STORAGE_KEY]: []});
  await chrome.runtime.sendMessage({type: "outbox-cleared"});
  showStatus("Pending uploads cleared.");
  await load();
});

load().catch((error) => { showStatus(error.message, "warning"); });
