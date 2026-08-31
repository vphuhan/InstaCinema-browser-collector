export const EXPORT_SCHEMA_VERSION = "1.0";

function findConnection(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value.edges) && value.page_info && typeof value.page_info === "object") {
    return value;
  }
  for (const child of Object.values(value)) {
    const connection = findConnection(child);
    if (connection) return connection;
  }
  return null;
}

export function pageItems(body) {
  if (!body || typeof body !== "object") return [];
  const legacyPage = body.save_media_response || body;
  if (Array.isArray(legacyPage.items)) {
    return legacyPage.items
      .filter((item) => item && typeof item === "object")
      .map((item) => item.media || item);
  }

  const collection = body.data?.fetch__MediaCollection;
  const connection = collection?.media || findConnection(body);
  if (!connection || !Array.isArray(connection.edges)) return [];
  return connection.edges
    .map((edge) => edge?.node?.media || edge?.node)
    .filter((item) => item && typeof item === "object");
}

function itemType(item) {
  if (Array.isArray(item.carousel_media) && item.carousel_media.length) return "carousel";
  if (item.media_type === 2 || item.video_versions) return "video";
  if (item.media_type === 1 || item.image_versions2) return "image";
  return String(item.product_type || "unknown");
}

function firstCandidate(values) {
  return Array.isArray(values) && values[0] && typeof values[0] === "object"
    ? values[0]
    : null;
}

function imageCandidate(node) {
  return firstCandidate(node.image_versions2?.candidates);
}

function normalizeMedia(node, position) {
  const video = node.media_type === 2 || Boolean(node.video_versions);
  const image = imageCandidate(node);
  const videoVersion = firstCandidate(node.video_versions);
  const url = video ? videoVersion?.url : image?.url;
  return {
    platform_media_id: String(node.pk || node.id || "") || null,
    position,
    media_type: video ? "video" : "image",
    url: url || null,
    thumbnail_url: video ? image?.url || null : null,
    width: node.original_width ?? image?.width ?? null,
    height: node.original_height ?? image?.height ?? null,
    duration_seconds: node.video_duration ?? null,
  };
}

function publishedAt(item) {
  if (typeof item.taken_at === "number" && Number.isFinite(item.taken_at)) {
    return new Date(item.taken_at * 1000).toISOString();
  }
  if (typeof item.taken_at === "string" && item.taken_at) {
    const parsed = new Date(item.taken_at);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return null;
}

function normalizeLocation(location) {
  if (!location || typeof location !== "object") return null;
  const normalized = {
    platform_location_id: String(location.pk || location.id || "") || null,
    name: location.name || null,
    address: location.address || null,
    city: location.city || null,
    latitude: location.lat ?? location.latitude ?? null,
    longitude: location.lng ?? location.longitude ?? null,
  };
  return Object.values(normalized).some((value) => value !== null) ? normalized : null;
}

function normalizeItem(item, position) {
  const platformItemId = String(item.pk || item.id || "");
  if (!platformItemId) return null;
  const caption = item.caption;
  const author = item.user || item.owner || {};
  const mediaNodes = Array.isArray(item.carousel_media) && item.carousel_media.length
    ? item.carousel_media
    : [item];
  return {
    position,
    platform_item_id: platformItemId,
    item_type: itemType(item),
    canonical_url: item.code ? `https://www.instagram.com/p/${item.code}/` : null,
    author_id: String(author.pk || author.id || "") || null,
    author_name: author.username || author.full_name || null,
    description: typeof caption === "string" ? caption : caption?.text || null,
    accessibility_caption: item.accessibility_caption || null,
    published_at: publishedAt(item),
    like_count: item.like_count ?? null,
    comment_count: item.comment_count ?? null,
    location: normalizeLocation(item.location),
    media: mediaNodes.map(normalizeMedia),
  };
}

function collectionFromPages(pages) {
  for (const page of pages) {
    const collection = page.body?.data?.fetch__MediaCollection;
    if (collection && typeof collection === "object") return collection;
  }
  return null;
}

export function normalizeCapture(pages, summary = {}) {
  const orderedPages = [...(Array.isArray(pages) ? pages : [])]
    .sort((left, right) => (left.page_index ?? 0) - (right.page_index ?? 0));
  const seen = new Set();
  const items = [];
  for (const page of orderedPages) {
    for (const sourceItem of pageItems(page.body)) {
      const id = String(sourceItem.pk || sourceItem.id || "");
      if (!id || seen.has(id)) continue;
      const normalized = normalizeItem(sourceItem, items.length);
      if (!normalized) continue;
      seen.add(id);
      items.push(normalized);
    }
  }

  const capturedCollection = collectionFromPages(orderedPages);
  const collectionPk = summary.collection_pk
    || orderedPages.find((page) => page.collection_id)?.collection_id
    || capturedCollection?.id
    || null;
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    collection: {
      platform: "instagram",
      platform_collection_id: collectionPk ? String(collectionPk) : null,
      name: summary.collection_name || capturedCollection?.name || "Collection",
      capture_status: summary.capture_status || "completed",
      started_at: summary.started_at || null,
      finished_at: summary.finished_at || null,
      page_count: orderedPages.length,
      item_count: items.length,
    },
    items,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function normalizedCollectionToCsv(normalized) {
  const columns = [
    "position", "platform_item_id", "item_type", "canonical_url", "author_id",
    "author_name", "description", "accessibility_caption", "published_at",
    "like_count", "comment_count", "location", "media_count", "media_types",
    "media_urls", "thumbnail_urls",
  ];
  const rows = normalized.items.map((item) => {
    const values = {
      ...item,
      location: item.location,
      media_count: item.media.length,
      media_types: item.media.map((media) => media.media_type),
      media_urls: item.media.map((media) => media.url).filter(Boolean),
      thumbnail_urls: item.media.map((media) => media.thumbnail_url).filter(Boolean),
    };
    return columns.map((column) => csvCell(values[column])).join(",");
  });
  return `\uFEFF${columns.join(",")}\r\n${rows.join("\r\n")}`;
}
