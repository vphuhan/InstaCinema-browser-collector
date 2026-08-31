import {DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY} from "./settings.js";
const jsonInput = document.querySelector("#format-json");
const csvInput = document.querySelector("#format-csv");
const rawJsonInput = document.querySelector("#format-raw-json");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const statusTitle = document.querySelector("#status-title");
const statusText = document.querySelector("#status");
const statusDot = document.querySelector("#status-dot");
const formatError = document.querySelector("#format-error");

async function settings() {
  const stored = await chrome.storage.local.get({[SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS});
  return {...DEFAULT_SETTINGS, ...stored[SETTINGS_STORAGE_KEY]};
}

async function saveFormats() {
  const current = await settings();
  current.export_json = jsonInput.checked;
  current.export_csv = csvInput.checked;
  current.export_raw_json = rawJsonInput.checked;
  await chrome.storage.local.set({[SETTINGS_STORAGE_KEY]: current});
  formatError.hidden = current.export_json || current.export_csv || current.export_raw_json;
  return current;
}

function renderState(state) {
  startButton.hidden = state.running;
  stopButton.hidden = !state.running;
  jsonInput.disabled = state.running;
  csvInput.disabled = state.running;
  rawJsonInput.disabled = state.running;
  statusDot.className = `status-dot ${state.running ? "running" : ""}`;
  statusTitle.textContent = state.running
    ? `${state.item_count || 0} items captured`
    : "Ready";
  statusText.textContent = state.message || "Open a saved collection to begin.";
}

async function initialize() {
  const current = await settings();
  jsonInput.checked = current.export_json;
  csvInput.checked = current.export_csv;
  rawJsonInput.checked = current.export_raw_json;
  const state = await chrome.runtime.sendMessage({type: "get-state"});
  renderState(state || {running: false});
}

for (const input of [jsonInput, csvInput, rawJsonInput]) {
  input.addEventListener("change", saveFormats);
}

startButton.addEventListener("click", async () => {
  const current = await saveFormats();
  if (!current.export_json && !current.export_csv && !current.export_raw_json) return;
  startButton.disabled = true;
  const response = await chrome.runtime.sendMessage({type: "start"});
  startButton.disabled = false;
  renderState(response || {running: false, message: "Could not start capture."});
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  const response = await chrome.runtime.sendMessage({type: "stop"});
  stopButton.disabled = false;
  renderState(response || {running: false, message: "Capture stopped."});
});

document.querySelector("#advanced").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "status") return;
  statusText.textContent = message.message;
  chrome.runtime.sendMessage({type: "get-state"}).then(renderState).catch(() => {});
});

initialize().catch((error) => {
  statusTitle.textContent = "Extension error";
  statusText.textContent = error.message;
});
