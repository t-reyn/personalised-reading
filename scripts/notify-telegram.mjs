#!/usr/bin/env node
// Send the day's issue as a Telegram message — the daily nudge for a one-article-a-day product.
// Called by generate.yml after Pages deploy (so the link is live). Zero-dep, and best-effort by
// design: the workflow treats a failure here as non-fatal because the issue has already shipped.
//   Usage: node scripts/notify-telegram.mjs [YYYY-MM-DD]     (defaults to today in Sydney)
//   Env:   TELEGRAM_BOT_TOKEN  from @BotFather
//          TELEGRAM_CHAT_ID    your own chat with the bot (send it /start, then read
//                              https://api.telegram.org/bot<TOKEN>/getUpdates → message.chat.id)
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (p) => JSON.parse(await readFile(join(ROOT, p), "utf8"));

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) {
  console.error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
  process.exit(1);
}

const day = process.argv[2] ||
  new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const config = await readJson("data/config.json");
const manifest = await readJson("data/manifest.json");
const todays = (manifest.articles || []).filter((a) => a.created_at === day);
if (!todays.length) {
  console.log(`no article dated ${day} in the manifest — nothing to nudge`);
  process.exit(0);
}

// Telegram HTML parse mode accepts only a small tag set; everything else must be entity-escaped.
const esc = (s = "") => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const site = (config.siteUrl || "").replace(/\/$/, "");
const interestName = (id) => (config.interests || []).find((i) => i.id === id)?.label || id;

const lines = [`\u{1F4D6} <b>${esc(config.title || "Cortex")}</b> — today's read`];
for (const a of todays) {
  lines.push("");
  lines.push(`<b>${esc(a.title)}</b>`);
  if (a.summary) lines.push(esc(a.summary));
  lines.push(`<i>${esc(interestName(a.interest))}</i> · ${site}/`);
}

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML" }),
  signal: AbortSignal.timeout(15000),
});
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.ok) {
  console.error(`telegram sendMessage failed: HTTP ${res.status} — ${JSON.stringify(body).slice(0, 300)}`);
  process.exit(1);
}
console.log(`nudged: ${todays.map((a) => a.title).join(" | ")}`);
