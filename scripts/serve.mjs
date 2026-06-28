// Dev-only zero-dep static server (not used in production; GitHub Pages serves the files).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const ROOT = process.cwd();
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 4317;
const TYPES = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".json":"application/json", ".svg":"image/svg+xml", ".xml":"application/xml", ".webmanifest":"application/manifest+json", ".ico":"image/x-icon" };
createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch { res.writeHead(404).end("not found"); }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
