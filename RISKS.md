# Browser collector risks and publication notes

## Current runtime risks

- **Debugger attachment:** Chrome can reject attachment if another debugger is active, the tab closes, or the user navigates away.
- **Authentication:** Instagram may return `401`, `403`, rate limits, or security challenges even when the browser UI is logged in.
- **Pagination changes:** Instagram may rename endpoints or move `items`, `next_max_id`, and `more_available` to another response shape.
- **Request replay:** A cursor request can return HTTP 200 but still fail to appear as a debugger network event. The extension therefore reads the page-side fetch body directly and keeps scrolling as a fallback.
- **Response timing:** Chrome may discard a response body before `Network.getResponseBody` is called.
- **Duplicate responses:** The same page can arrive through the browser request and the extension's page-side fetch. Captures are deduplicated by normalized URL and cursor.
- **Storage and export:** `chrome.storage.local` can hit quota limits; Downloads can be blocked or fail.
- **Service-worker lifecycle:** Manifest V3 workers can be suspended between asynchronous operations.
- **Private data:** Captured responses can contain captions, usernames, comments, media metadata, and signed media URLs. Do not commit or share capture files.
- **Platform dependency:** This relies on undocumented Instagram web behavior and can break without notice.

## Publishing with `chrome.debugger`

The `debugger` permission is a serious limitation for a public extension. Chrome warns users that it can access and change data on all websites, and the permission is not optional. It is also much broader than this project's actual Instagram-only use.

Publishing is not automatically impossible, but review risk is high. A public listing would need:

1. A narrowly stated single purpose.
2. Clear disclosure and affirmative consent for collecting private Instagram data.
3. A public, accurate privacy policy describing collection, use, storage, and sharing.
4. A strong explanation for why `debugger` is necessary and why narrower APIs do not work.
5. No hidden cookie/session extraction or undisclosed uploads.
6. Secure transport and handling for any data sent outside the browser.

For this personal project, keep using **Load unpacked**. If a public version becomes important, first redesign around the narrowest feasible API and validate it with an unlisted/private Chrome Web Store test release. Chrome applies the same policy requirements to private, unlisted, and public visibility.

Official references:

- [Chrome permissions: debugger](https://developer.chrome.com/docs/extensions/reference/permissions-list)
- [Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Chrome Web Store distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
