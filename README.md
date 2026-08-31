# InstaCinema Browser Collector

A Chromium extension that exports the posts in an Instagram saved collection
as JSON. It works from your existing Instagram browser session, so it does not
ask for your password, cookies, or session ID.

The local JSON export works without the InstaCinema backend. When the optional
local ingestion API is available at `http://127.0.0.1:8000`, captured pages are
also uploaded in the background for storage and normalization.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome, or `brave://extensions` in Brave.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose this repository's folder.
5. Pin **InstaCinema Browser Collector** to the browser toolbar.

No build step or package installation is required.

## Collect a saved collection

1. Sign in to [Instagram](https://www.instagram.com/) normally.
2. Open one specific saved collection. Its URL should resemble:
   `https://www.instagram.com/<username>/saved/<name>/<collection-id>/`.
3. Click the InstaCinema toolbar icon.
4. Leave that tab open while the dim capture overlay is visible.
5. Wait for the extension to finish, or click the icon again to stop early.

The extension reloads the selected tab, follows Instagram's collection
pagination, and downloads the captured pages automatically as:

```text
Instagram - <Collection name> (YYYY-MM-DD HH-MM-SS).json
```

Stopping early still exports everything captured so far.

## Status badge

- Blue number: unique items captured in the active run.
- Purple number: captured items still waiting for the optional local API.
- `RUN`: capture has started but no items have been received yet.
- `↑`: background ingestion is active without an available item count.
- `OFF`: capture is idle and there are no pending uploads.
- `!`: the local API rejected an upload that needs inspection.

Large counts are shortened to fit the badge, such as `1.2K` or `12K`.

## Output

The downloaded file contains run metadata and the Instagram response pages:

```json
{
  "run_id": "...",
  "platform": "instagram",
  "collector": "instagram-extension",
  "collection_name": "Film",
  "collection_pk": "...",
  "capture_status": "completed",
  "page_count": 6,
  "pages": []
}
```

Each page is written to `chrome.storage.local` before any upload is attempted.
If the optional API is offline, the local export still completes and pending
uploads remain in the extension's outbox for a later retry.

## Optional local API

The extension sends ingestion requests only to `http://127.0.0.1:8000`:

- `POST /api/v1/ingestion/runs`
- `PUT /api/v1/ingestion/runs/{run_id}/pages/{page_index}`
- `POST /api/v1/ingestion/runs/{run_id}/finish`

Cloud credentials never belong in the extension. A compatible local API is
responsible for authentication, object storage, and downstream processing.

## Permissions and privacy

- `debugger`: observes the selected Instagram tab's collection responses.
- `activeTab` and `scripting`: controls scrolling only in the selected tab.
- `storage` and `unlimitedStorage`: keeps captured pages and pending uploads.
- `downloads`: writes the completed JSON file.
- `alarms`: resumes pending local-API uploads.

Chromium displays a debugger notification while capture is active. The
extension detaches when capture finishes or is stopped. Captures can contain
private saved-post information, so review the JSON before sharing it and do not
commit personal capture files to Git.

## Update

After pulling a newer version, open the browser's extensions page and click
**Reload** on the InstaCinema extension card.
