// Scan articles/, extract the inline #meta JSON, validate, return sorted records.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { hasRawEntity } from "./text.mjs";

const META_RE = /<script\s+type="application\/json"\s+id="meta">([\s\S]*?)<\/script>/i;
const REQUIRED = ["id", "slug", "interest", "title", "summary", "created_at"];

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith("_")) continue; // skip _drafts and similar
      out.push(...(await walk(p)));
    } else if (e.name.endsWith(".html")) {
      out.push(p);
    }
  }
  return out;
}

const relPath = (file, root) => relative(root, file).split(sep).join("/");

export async function scanArticles(articlesDir, repoRoot) {
  const files = await walk(articlesDir);
  const results = [];

  for (const file of files) {
    const path = relPath(file, repoRoot);
    const html = await readFile(file, "utf8");
    const warnings = [];

    const m = META_RE.exec(html);
    if (!m) {
      warnings.push("no #meta block");
      results.push({ path, meta: null, warnings });
      continue;
    }

    let meta;
    try {
      meta = JSON.parse(m[1]);
    } catch (err) {
      warnings.push(`#meta is not valid JSON: ${err.message}`);
      results.push({ path, meta: null, warnings });
      continue;
    }

    for (const k of REQUIRED) {
      if (meta[k] == null || meta[k] === "") warnings.push(`missing "${k}"`);
    }
    if (hasRawEntity(meta.title)) warnings.push("raw HTML entity in title");
    if (hasRawEntity(meta.summary)) warnings.push("raw HTML entity in summary");
    if (/\{\{[A-Z_]+\}\}/.test(html)) warnings.push("unfilled {{PLACEHOLDER}} left in file");

    meta.path = path;
    results.push({ path, meta, warnings });
  }

  results.sort((a, b) => {
    const da = a.meta?.created_at ?? "";
    const db = b.meta?.created_at ?? "";
    if (da !== db) return db.localeCompare(da);
    return (a.meta?.title ?? "").localeCompare(b.meta?.title ?? "");
  });
  return results;
}
