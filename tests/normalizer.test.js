import assert from "node:assert/strict";
import test from "node:test";

import {normalizeCapture, normalizedCollectionToCsv, pageItems} from "../normalizer.js";
import {DEFAULT_SETTINGS} from "../settings.js";

const image = (pk, code, description) => ({
  pk,
  code,
  media_type: 1,
  taken_at: 1700000000,
  caption: {text: description},
  user: {pk: "42", username: "cinephile"},
  accessibility_caption: "A generated image description",
  like_count: 12,
  comment_count: 3,
  image_versions2: {candidates: [{url: `https://media.test/${pk}.jpg`, width: 1080, height: 1350}]},
});

test("defaults to JSON-only local export", () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    export_json: true,
    export_csv: false,
    export_raw_json: false,
    capture_method: "scroll",
    ingestion_enabled: false,
  });
});

test("normalizes ordered GraphQL pages and removes duplicate posts", () => {
  const first = image("1", "FIRST", "First caption");
  const second = {
    ...image("2", "SECOND", "Second, \"quoted\"\ncaption"),
    carousel_media: [
      image("21", "", ""),
      {...image("22", "", ""), media_type: 2, video_versions: [{url: "https://media.test/22.mp4"}], video_duration: 4.5},
    ],
  };
  const pages = [
    {
      page_index: 1,
      collection_id: "99",
      body: {data: {fetch__MediaCollection: {id: "99", name: "Film", media: {
        edges: [{node: second}, {node: first}],
        page_info: {has_next_page: false},
      }}}},
    },
    {
      page_index: 0,
      body: {data: {fetch__MediaCollection: {id: "99", name: "Film", media: {
        edges: [{node: first}],
        page_info: {has_next_page: true, end_cursor: "next"},
      }}}},
    },
  ];

  const result = normalizeCapture(pages, {
    capture_status: "completed",
    started_at: "2026-08-31T00:00:00Z",
    finished_at: "2026-08-31T00:01:00Z",
  });

  assert.equal(result.collection.name, "Film");
  assert.equal(result.collection.item_count, 2);
  assert.deepEqual(result.items.map((item) => item.platform_item_id), ["1", "2"]);
  assert.deepEqual(result.items.map((item) => item.position), [0, 1]);
  assert.equal(result.items[1].item_type, "carousel");
  assert.deepEqual(result.items[1].media.map((media) => media.media_type), ["image", "video"]);
  assert.equal(result.items[1].media[1].duration_seconds, 4.5);
});

test("supports the legacy saved collection response shape", () => {
  const item = image("3", "LEGACY", "Legacy caption");
  const body = {save_media_response: {items: [{media: item}], more_available: false}};
  assert.deepEqual(pageItems(body), [item]);
  const result = normalizeCapture([{page_index: 0, collection_id: "77", body}], {
    collection_name: "Places",
    capture_status: "stopped",
  });
  assert.equal(result.collection.platform_collection_id, "77");
  assert.equal(result.collection.capture_status, "stopped");
  assert.equal(result.items[0].canonical_url, "https://www.instagram.com/p/LEGACY/");
});

test("creates Excel-friendly CSV and escapes nested and multiline values", () => {
  const result = normalizeCapture([{
    page_index: 0,
    body: {items: [image("4", "CSV", "Comma, quote \" and\nnewline")]},
  }], {collection_name: "CSV"});
  const csv = normalizedCollectionToCsv(result);
  assert.ok(csv.startsWith("\uFEFFposition,"));
  assert.match(csv, /"Comma, quote "" and\nnewline"/);
  assert.match(csv, /"\[""image""\]"/);
  assert.match(csv, /https:\/\/media\.test\/4\.jpg/);
});
