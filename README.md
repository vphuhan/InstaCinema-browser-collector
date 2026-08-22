# InstaCinema Browser Collector

This is a local proof of concept for collecting data from a user-authenticated Instagram tab without asking the user to copy cookies or parsing rendered HTML.

## Current design

```text
User opens Instagram and logs in normally
        ↓
User clicks Start in this extension
        ↓
Extension attaches Chrome DevTools Protocol to that tab
        ↓
Extension triggers small scrolls
        ↓
Instagram makes its normal authenticated requests
        ↓
Extension captures matching response bodies
        ↓
Extension forwards them to localhost only
```

The extension currently filters the private collection endpoint names found in the installed `aiograpi` package:

- `/api/v1/collections/list/`
- `/api/v1/feed/collection/`
- `/api/v1/feed/saved/posts/`

The browser may use different web endpoints. Add confirmed patterns to `service_worker.js` under `PLACEHOLDER_ENDPOINT_PATTERNS` after observing them in DevTools.

## Local installation

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this `browser_extension/` directory.
5. Open Instagram, navigate to the relevant collection, and click the extension.
6. Click the extension icon to start collection automatically. Use the popup's **Stop** button when finished. The extension uses Chrome DevTools Protocol gestures; it does not parse the page HTML.

The extension sends a fast, large Chrome DevTools Protocol scroll gesture from inside the visible viewport, waits briefly for matching network activity, and only then sends the next gesture. It stops after eight gestures without a matching response. This follows the usual infinite-scroll automation pattern: trigger scrolling, wait for the concrete next-page response, then continue.

Chrome will show a powerful debugger permission warning. This extension is intended for local personal development only. It does not read cookies and does not send captured data outside `http://127.0.0.1:8000`.

## Backend contract

The backend endpoint is not implemented yet. The extension sends one JSON envelope per matching response:

```json
{
  "source": "instagram-browser",
  "tab_url": "https://www.instagram.com/...",
  "request_url": "https://www.instagram.com/api/...",
  "request_id": "123.45",
  "status": 200,
  "mime_type": "application/json",
  "body": {}
}
```

Until the backend endpoint exists, forwarding failures are shown in the extension status and the payload remains visible in the service-worker console for local debugging.

Captured response envelopes are also stored in `chrome.storage.local`. Use the popup's **Save as** field and **Export JSON** button to download them. Chrome accepts a path relative to the user's Downloads directory, such as `instacinema/instagram-captures.json`; an arbitrary absolute filesystem path is not permitted by the extension API.

While `DISCOVERY_MODE` is enabled, the service-worker console also logs metadata for every XHR/fetch response from the attached Instagram tab. Use that log to identify the browser-specific collection endpoint, then add its path to `PLACEHOLDER_ENDPOINT_PATTERNS` and disable discovery when you no longer need it.

## Security boundary

- No password or cookie extraction.
- No external upload endpoint.
- Only the user-selected tab is attached.
- The user must explicitly start collection.
- Captured responses may contain private account data; do not commit them.
