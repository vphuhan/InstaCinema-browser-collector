# StashTable

**Turn saved collections into useful data.**

Export the posts in an Instagram saved collection as a clean JSON file or CSV
table. The extension uses your existing Instagram browser session: it never
asks for your password, cookies, or session ID.

Everything works locally by default. No server, account setup, build step, or
package installation is required.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome or `brave://extensions` in Brave.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this repository's folder.
5. Pin **StashTable** to the toolbar.

## Export a collection

1. Sign in to [Instagram](https://www.instagram.com/) normally.
2. Open one specific saved collection. Its URL should resemble:
   `https://www.instagram.com/<username>/saved/<name>/<collection-id>/`.
3. Click the extension icon.
4. Keep **Normalized JSON** selected, optionally select **CSV table**, and click
   **Start capture**.
5. Leave that Instagram tab open while the dim overlay is visible.

The extension stops when Instagram reports that no more pages are available.
You can reopen the popup and choose **Stop and export** to keep a partial result.

Files are downloaded automatically:

```text
Instagram - <Collection name> (YYYY-MM-DD HH-MM-SS).json
Instagram - <Collection name> (YYYY-MM-DD HH-MM-SS).csv
```

JSON is selected by default. Export choices are remembered for the next run.

## Exported data

The JSON output contains collection metadata and a normalized `items` array:

```json
{
  "schema_version": "1.0",
  "collection": {
    "platform": "instagram",
    "platform_collection_id": "...",
    "name": "Film",
    "capture_status": "completed",
    "page_count": 6,
    "item_count": 66
  },
  "items": []
}
```

Each item contains its collection position, Instagram ID, type, post URL,
author, caption, accessibility description, publication time, engagement and
location metadata, and an ordered media list. Carousel posts remain one item
with multiple media entries.

CSV contains one row per Instagram post. Media types, URLs, and thumbnails are
stored as JSON arrays inside their cells so carousel data is not discarded.
CSV files are UTF-8 and compatible with Excel, Numbers, Google Sheets, and
LibreOffice.

Instagram media URLs may be signed and can expire. The post's canonical URL and
stable Instagram identifiers remain in the export.

## Status

- Blue badge: capture is running; the badge displays the current item count.
- `RUN`: capture started but no items have arrived yet.
- `OFF`: capture is idle.
- Purple badge or `↑`: optional local API uploads are pending.
- `!`: the optional local API rejected an upload.

## Optional local API ingestion

This section is only for developers running a compatible ingestion service.
Ordinary exports do not use it.

Open **Advanced settings** from the extension popup and enable **Upload raw
pages to local API**. Chromium then asks for access to
`http://127.0.0.1:8000`. When enabled, the extension sends the original raw
pages through these endpoints while local exports remain normalized:

- `POST /api/v1/ingestion/runs`
- `PUT /api/v1/ingestion/runs/{run_id}/pages/{page_index}`
- `POST /api/v1/ingestion/runs/{run_id}/finish`

Uploads use a durable local outbox and do not block Instagram capture. Disabling
ingestion prevents new uploads and preserves existing pending requests until
you re-enable ingestion or explicitly clear them. Cloud credentials must remain
in the local backend and must never be added to this extension.

## Permissions and privacy

- `debugger`: reads collection response bodies from the selected Instagram tab.
- `activeTab` and `scripting`: reload and scroll only the selected tab.
- `storage` and `unlimitedStorage`: retain the active capture and optional
  pending uploads.
- `downloads`: save selected export formats.
- `alarms`: resume optional pending uploads.

Chromium displays a debugger notification during capture and removes it after
the extension finishes or is stopped. Normalized exports exclude cookies,
request headers, CSRF tokens, session IDs, and raw response envelopes. Saved
collections are private personal data, so review exported files before sharing
them.

## Development

There are no runtime dependencies or build step. Contributors with Node.js can
run the pure exporter checks:

```bash
npm test
npm run check
```

After pulling source changes, open the browser's extensions page and click
**Reload** on the extension card.
