// Asking a question on a History card (1.8). DOM-free. The question goes to the companion as an ask job tied to the
// entry (entry = its job id), so the answer is asked against the kept full transcript and saved with that entry; the
// card's earlier Q&A and its summary go along as context, the same caps as the panel.
import { request } from "./api.js";
import { ASK_LIMITS, askProvider, capHistory, capSummary, charCount, cleanQuestion } from "./ask.js";
import { describeError } from "./controller.js";

export const CARD_POLL_MS = 1200;
const RETRIES = 3;

// entry: a /history entry ({url, mode, job_id, summary, qa}). Resolves { q, a } or { error }.
// deps: fetch, cfg {base, token}, uuid(), wait(ms) (a promise), codexOk (true/false/null), onLabel(text)
export async function askEntry(deps, entry, question) {
  const { fetch, cfg, uuid, wait, codexOk = null, onLabel = () => {} } = deps;
  const q = cleanQuestion(question);
  if (!q) return { error: "Type or say a question first." };
  if (charCount(q) > ASK_LIMITS.question) return { error: `That question is too long (over ${ASK_LIMITS.question} characters).` };
  if (!entry || !/^[0-9a-f]{32}$/.test(entry.job_id || "") || !entry.url) return { error: "This entry cannot take questions (it has no saved source)." };
  const summary = capSummary(entry.summary);
  const body = { url: entry.url, mode: `${askProvider(entry.mode, codexOk)}-ask`, requestId: uuid(), question: q,
                 history: capHistory(entry.qa), ...(summary ? { summary } : {}), entry: entry.job_id, force: false };
  onLabel("Thinking...");
  let r;
  try { r = await request(fetch, cfg, "POST", "/jobs", body, 10000); } catch (e) { return { error: e.message || "The iMac did not answer." }; }
  if (r.status === 401) return { error: "The token was rejected. Check the options page." };
  if (r.status >= 400 || !r.json || !r.json.job_id) return { error: describeError(r.json?.error_code, r.json?.error_message) };
  const id = r.json.job_id;
  for (let misses = 0; ;) {
    let p;
    try {
      p = await request(fetch, cfg, "GET", `/jobs/${id}`, null, 10000);
    } catch (e) {
      if (++misses > RETRIES) return { error: e.message || "The iMac did not answer." };
      onLabel("Waiting for the iMac...");
      await wait(CARD_POLL_MS);
      continue;
    }
    misses = 0;
    if (p.status >= 400) return { error: describeError(p.json?.error_code, p.json?.error_message) };
    const j = p.json || {};
    if (j.state === "done") return { q, a: j.result_markdown || "" };
    if (j.state === "error") return { error: describeError(j.error_code, j.error_message) };
    onLabel(j.state === "fetching" ? "Fetching the source..." : "Thinking...");
    await wait(CARD_POLL_MS);
  }
}
