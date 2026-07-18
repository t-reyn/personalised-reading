#!/usr/bin/env node
// TEMPORARY probe — delete once HANDOFF.md records the verdict. Answers ONE question with runner
// evidence: can a GitHub Actions IP use the ANDROID InnerTube route in scripts/lib/transcripts.mjs,
// or does YouTube bot-wall datacenter IPs there? (A local success proves nothing — the Substack
// lesson.) Exit code stays 0 either way; the LOG is the evidence.
import { fetchTranscript } from "./lib/transcripts.mjs";

const VIDEOS = [
  "https://www.youtube.com/watch?v=5D4Zqp9GLSc", // Fireship (auto captions)
  "https://www.youtube.com/watch?v=8R6fYMJLI5E", // Chris Raroque (auto captions)
  "https://www.youtube.com/watch?v=Et45hFGwSqQ", // Raroque #2
];

for (const u of VIDEOS) {
  const r = await fetchTranscript(u);
  console.log(u.slice(-11), "→", r.reason ? `FAIL: ${r.reason}` : `OK (${r.kind}), ${r.text.length} chars: "${r.text.slice(0, 80)}"`);
}
