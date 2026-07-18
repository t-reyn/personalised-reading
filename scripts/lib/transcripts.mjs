// Zero-dep YouTube transcript extraction. A channel RSS item carries only the description, so a
// video in the pool is a *lead*, not a source, until its transcript is captured.
//
// ROUTE CHOICE (measured 2026-07-18, don't "simplify" back):
//   - The classic route — scrape captionTracks from the watch page, fetch baseUrl — now returns
//     HTTP 200 with a ZERO-BYTE body: web-client timedtext URLs require a PO (proof-of-origin)
//     token since ~2024. Looks like success, is silent failure.
//   - /youtubei/v1/get_transcript 400s ("Precondition check failed") even with the page's own
//     embedded params, client version and API key.
//   - The InnerTube player call with an ANDROID client context is what still works: its caption
//     baseUrls are not PO-token-gated. It answers in srv3 format (<p>/<s> word segments), hence
//     the two-format parser below.
// Whether YouTube bot-walls DATACENTER IPs on this endpoint (playability LOGIN_REQUIRED, "Sign in
// to confirm you're not a bot") is a separate, empirical question — check probe evidence in
// HANDOFF.md before assuming the cloud runner can use this. All failures return {text:null,reason}.

const ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";
const ANDROID_CONTEXT = { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en" } };

// Prefer a human-made English track over auto-generated (kind:"asr"), English over anything else.
export function pickTrack(tracks, langPrefixes = ["en"]) {
  if (!tracks.length) return null;
  const score = (t) =>
    (langPrefixes.some((l) => (t.languageCode || "").startsWith(l)) ? 0 : 2) + (t.kind === "asr" ? 1 : 0);
  return [...tracks].sort((a, b) => score(a) - score(b))[0];
}

// timedtext → plain prose. Handles BOTH wire formats: srv1 (<text start dur>cue</text>, what the
// old web URLs served) and srv3 (<p t d><s>word</s><s> word</s></p>, what the ANDROID client
// serves). Cues are entity-encoded and may carry <b>/<i>/<s> markup — strip after joining.
export function parseTimedText(xml) {
  const parts = [];
  let re = /<text[^>]*>([\s\S]*?)<\/text>/g, m;
  while ((m = re.exec(xml))) parts.push(m[1]);
  if (!parts.length) {
    re = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
    while ((m = re.exec(xml))) parts.push(m[1]);
  }
  return parts.join(" ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

export function videoId(url) {
  const m = /[?&]v=([\w-]{11})/.exec(url) || /youtu\.be\/([\w-]{11})/.exec(url) || /\/(?:shorts|embed)\/([\w-]{11})/.exec(url);
  return m ? m[1] : null;
}

// End-to-end: video URL → transcript text (or null with a reason). `maxChars` bounds what the
// caller keeps. Never throws for an expected condition.
export async function fetchTranscript(url, { maxChars = 4000, timeoutMs = 15000 } = {}) {
  const id = videoId(url);
  if (!id) return { text: null, reason: "no video id in url" };
  let player;
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": ANDROID_UA },
      body: JSON.stringify({ context: ANDROID_CONTEXT, videoId: id }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { text: null, reason: `player HTTP ${res.status}` };
    player = await res.json();
  } catch (e) { return { text: null, reason: `player: ${e.message}` }; }
  const status = player?.playabilityStatus?.status;
  if (status !== "OK") {
    const why = player?.playabilityStatus?.reason || "";
    return { text: null, reason: `playability ${status || "unknown"}${why ? ` — ${why}` : ""}` };
  }
  const track = pickTrack(player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []);
  if (!track?.baseUrl) return { text: null, reason: "no caption track" };
  try {
    const res = await fetch(track.baseUrl, {
      headers: { "User-Agent": ANDROID_UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { text: null, reason: `timedtext HTTP ${res.status}` };
    const text = parseTimedText(await res.text());
    if (!text) return { text: null, reason: "empty transcript" };
    return { text: text.slice(0, maxChars), reason: null, kind: track.kind === "asr" ? "auto" : "manual" };
  } catch (e) { return { text: null, reason: `timedtext: ${e.message}` }; }
}
