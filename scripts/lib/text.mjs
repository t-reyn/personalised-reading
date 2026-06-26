// Zero-dependency string helpers shared by the generators.

export function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
export const escapeXml = escapeHtml;

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
export function stripHtml(s = "") {
  return String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITIES[m] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function truncate(s = "", n = 200) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

export function humanDate(iso) {
  if (!iso) return "";
  const d = new Date(String(iso).length === 10 ? iso + "T00:00:00Z" : iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function toRfc822(iso) {
  const d = new Date(String(iso).length === 10 ? iso + "T00:00:00Z" : iso);
  return isNaN(d.getTime()) ? new Date(0).toUTCString() : d.toUTCString();
}

// Plain-text #meta fields (title/summary) should never contain HTML entities — a leak signals a slip.
export function hasRawEntity(s = "") {
  return /&(?:amp|lt|gt|quot|nbsp|#\d+|[a-zA-Z]+);/.test(String(s));
}
