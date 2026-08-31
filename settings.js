export const SETTINGS_STORAGE_KEY = "userSettings";
export const OUTBOX_STORAGE_KEY = "ingestionOutbox";
export const LOCAL_BACKEND_PERMISSION = "http://127.0.0.1:8000/*";
export const DEFAULT_SETTINGS = Object.freeze({
  export_json: true,
  export_csv: false,
  export_raw_json: false,
  capture_method: "scroll",
  ingestion_enabled: false,
});
