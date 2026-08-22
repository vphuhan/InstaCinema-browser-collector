# Browser Extension TODO

Build a local Chrome Manifest V3 collector that attaches to a user-selected Instagram tab, triggers ordinary page loading through controlled scrolling, captures selected network response bodies, and forwards them only to the local InstaCinema backend. Do not read or transmit passwords or cookies.

## Next improvements

- [ ] Normalize each captured response before storing it in extension storage to reduce memory and quota usage.
  - Keep post identity: `pk`, `code`, `media_type`, and `product_type`.
  - Keep extraction inputs: caption text, author identity, timestamp, and carousel child IDs/types.
  - Keep page metadata: collection ID/name, request URL, `more_available`, and `next_max_id`.
  - Discard or avoid persisting large video/audio manifests, signed media URLs, rendering metadata, and repeated nested profile fields.
  - Preserve the full raw response only through an explicit debugging export, not as the default in-run storage format.
