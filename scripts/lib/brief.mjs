// Read the research brief's machine-readable header.
//
// skills/RESEARCH.md requires data/brief-today.md to open with exactly one line:
//   <!-- meta: {"interest":"…","pick":"primary","mode":"learn","shape":null,"angle":"…","used_item_ids":[…]} -->
// It is the only structured handoff between the two Claude steps, so parsing it is deliberately
// strict about the things that would corrupt state (a missing interest, malformed JSON, an
// used_item_ids that isn't a list of ids) and lenient about the things that don't matter (leading
// blank lines, unknown extra keys, whitespace inside the comment).

const META_RE = /<!--\s*meta:\s*(\{[\s\S]*?\})\s*-->/;

const MODES = new Set(["current", "learn"]);
const PICKS = new Set(["primary", "fallback"]);

/**
 * @param markdown  the contents of data/brief-today.md
 * @returns { interest, pick, mode, shape, angle, used_item_ids }
 * @throws  Error with a message naming what is wrong (the workflow surfaces it in the log)
 */
export function parseBriefMeta(markdown = "") {
  const m = META_RE.exec(markdown);
  if (!m) throw new Error("brief has no `<!-- meta: {…} -->` header line");

  let meta;
  try {
    meta = JSON.parse(m[1]);
  } catch (err) {
    throw new Error(`brief meta is not valid JSON: ${err.message}`);
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("brief meta is not a JSON object");

  const interest = typeof meta.interest === "string" ? meta.interest.trim() : "";
  if (!interest) throw new Error('brief meta is missing "interest"');

  // Anything other than an array of non-empty strings means we cannot tell which pool items the
  // piece consumed. Consuming the wrong ids is worse than consuming none (it silently deletes
  // candidates the reader never got), so refuse rather than guess.
  const raw = meta.used_item_ids ?? [];
  if (!Array.isArray(raw)) throw new Error('brief meta "used_item_ids" must be an array');
  const ids = [];
  for (const id of raw) {
    if (typeof id !== "string" || !id.trim()) throw new Error('brief meta "used_item_ids" must contain only non-empty strings');
    if (!ids.includes(id.trim())) ids.push(id.trim());
  }

  return {
    interest,
    pick: PICKS.has(meta.pick) ? meta.pick : "primary",
    mode: MODES.has(meta.mode) ? meta.mode : null,
    shape: typeof meta.shape === "string" && meta.shape.trim() ? meta.shape.trim() : null,
    angle: typeof meta.angle === "string" ? meta.angle.trim() : "",
    used_item_ids: ids,
  };
}
