import {
  DEFAULT_SETTINGS,
  LOCAL_BACKEND_PERMISSION,
  OUTBOX_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
} from "./settings.js";
const ingestionInput = document.querySelector("#ingestion");
const permissionStatus = document.querySelector("#permission-status");
const pendingCount = document.querySelector("#pending-count");
const clearButton = document.querySelector("#clear-outbox");
const saveStatus = document.querySelector("#save-status");

async function load() {
  const stored = await chrome.storage.local.get({
    [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS,
    [OUTBOX_STORAGE_KEY]: [],
  });
  const current = {...DEFAULT_SETTINGS, ...stored[SETTINGS_STORAGE_KEY]};
  const permitted = await chrome.permissions.contains({origins: [LOCAL_BACKEND_PERMISSION]});
  ingestionInput.checked = current.ingestion_enabled && permitted;
  permissionStatus.textContent = permitted
    ? "Local API access is granted."
    : "Local API access is not granted.";
  pendingCount.textContent = stored[OUTBOX_STORAGE_KEY].length;
  clearButton.disabled = stored[OUTBOX_STORAGE_KEY].length === 0;
}

ingestionInput.addEventListener("change", async () => {
  let granted = false;
  if (ingestionInput.checked) {
    granted = await chrome.permissions.request({origins: [LOCAL_BACKEND_PERMISSION]});
    if (!granted) {
      ingestionInput.checked = false;
      saveStatus.textContent = "Local API access was not granted.";
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
  saveStatus.textContent = current.ingestion_enabled
    ? "Local API ingestion enabled."
    : "Local API ingestion disabled. Pending uploads were preserved.";
  await load();
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.set({[OUTBOX_STORAGE_KEY]: []});
  await chrome.runtime.sendMessage({type: "outbox-cleared"});
  saveStatus.textContent = "Pending uploads cleared.";
  await load();
});

load().catch((error) => { saveStatus.textContent = error.message; });
