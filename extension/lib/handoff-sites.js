// Keep site-specific selectors and waits here so a composer change is a one-line edit.
export const HANDOFF_SITES = {
  claude: {
    urlKey: "handoffClaudeUrl",
    defaultUrl: "https://claude.ai/project/01a13a90-61fa-72c2-acd7-b9f89d98fc71",
    host: "claude.ai",
    composer: '[data-testid="chat-input"]',
    send: 'button[aria-label="Send message"]',
    attachment: '[data-testid*="attachment"]',
    autoSend: false,
  },
  chatgpt: {
    urlKey: "handoffChatgptUrl",
    defaultUrl: "https://chatgpt.com/g/g-p-6acf8160e168819180fd9f0db14831f8/project",
    host: "chatgpt.com",
    composer: '[contenteditable="true"]',
    send: 'button[aria-label="Send"]',
    attachment: '[data-testid*="attachment"]',
    autoSend: true,
  },
};

export function validateHandoffUrl(value, site) {
  const config = typeof site === "string" ? HANDOFF_SITES[site] : site;
  if (!config) return { ok: false, error: "Choose Claude or ChatGPT." };
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== config.host || url.port || url.username || url.password) {
      return { ok: false, error: `Use an https://${config.host}/ address.` };
    }
    return { ok: true, value: url.href };
  } catch {
    return { ok: false, error: `Use a valid https://${config.host}/ address.` };
  }
}

export function handoffEnabled(state) {
  return !!(state && state.result && !state.busy && state.jobState === "done" && state.jobId && state.source && state.source.url);
}

export function buildHandoffText({ title, url, result, sourceText }) {
  const attached = typeof sourceText === "string" && sourceText.length > 0;
  const visible = [
    title || "Untitled source",
    url || "",
    result || "",
    attached ? "The full transcript or article text is attached below." : "The full transcript or article text could not be fetched; only the Dip and source link are included.",
  ].filter((part) => part !== "").join("\n\n");
  const source = attached ? `--- Full source text ---\n\n${sourceText}` : "";
  return { visibleText: visible, sourceText: source, fullText: [visible, source].filter(Boolean).join("\n\n") };
}

// This function is serialized by chrome.scripting.executeScript. Keep it self-contained; pass site settings as data.
export async function fillHandoffComposer(payload, site) {
  const text = payload.fullText;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const started = Date.now();
  const visible = (el) => !!el && (el.offsetParent !== null || !!el.getClientRects?.().length);
  const findEditor = () => {
    const candidates = [...document.querySelectorAll(site.composer)];
    return candidates.find((el) => visible(el) && (site.id !== "chatgpt" || el.isContentEditable)) || null;
  };
  const clipboard = async () => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
      } catch { return false; }
    }
  };
  const notice = () => {
    let node = document.getElementById("dipdive-handoff-notice");
    if (!node) {
      node = document.createElement("div");
      node.id = "dipdive-handoff-notice";
      node.textContent = "Dip'n'Dive: couldn't fill the message box. Everything is on your clipboard; paste it here.";
      Object.assign(node.style, { position: "fixed", zIndex: "2147483647", right: "16px", bottom: "16px", maxWidth: "360px", padding: "12px 16px", borderRadius: "10px", background: "#202124", color: "white", font: "14px/1.4 system-ui,sans-serif", boxShadow: "0 3px 16px #0008" });
      document.body.appendChild(node);
    }
    setTimeout(() => node.remove(), site.noticeMs || 12000);
  };
  const fail = async (reason) => { await clipboard(); notice(); return { ok: false, reason }; };
  let editor;
  while (!(editor = findEditor()) && Date.now() - started < site.findTimeoutMs) await sleep(site.pollMs);
  if (!editor) return fail("composer_not_found");
  try {
    // Live test, 14 October 2026: a paste sent the moment the editor appears can land before the site has wired up its
    // paste handling, and text inserted after a pasted block runs onto its last line. So wait for the page to settle,
    // insert the visible message first, then paste the source; the site may keep it inline or turn it into an attachment.
    await sleep(site.settleMs || 0);
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    editor.focus();
    document.execCommand("insertText", false, payload.visibleText);
    if (payload.sourceText) {
      await sleep(site.betweenMs || 0);
      editor.focus();
      const data = new DataTransfer();
      data.setData("text/plain", payload.sourceText);
      editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      await sleep(site.pasteWaitMs);
    }
    const editorText = norm(editor.innerText || editor.textContent || "");
    const textRegistered = editorText.includes(norm(payload.visibleText).slice(0, 60));
    const sourceInline = !!payload.sourceText && editorText.includes(norm(payload.sourceText).slice(0, 60));
    const attachment = !!document.querySelector(site.attachment) || /pasted/i.test(String(document.body.innerText || ""));
    const sourceRegistered = !payload.sourceText || sourceInline || attachment;
    if (!textRegistered || !sourceRegistered) return fail("fill_not_registered");
    if (site.autoSend) {
      const sendDeadline = Date.now() + site.sendTimeoutMs;
      let button;
      while (Date.now() < sendDeadline) {
        button = [...document.querySelectorAll(site.send)].find(visible);
        if (button && !button.disabled) break;
        await sleep(site.pollMs);
      }
      if (!button || button.disabled) return fail("send_not_enabled");
      button.click();
      return { ok: true, sent: true };
    }
    editor.focus();
    return { ok: true, sent: false };
  } catch (error) {
    return fail(String(error && error.message || error));
  }
}

export function injectionSite(id) {
  const base = HANDOFF_SITES[id];
  return { ...base, id, findTimeoutMs: 15000, sendTimeoutMs: 30000, pollMs: 250, settleMs: 1500, betweenMs: 300, pasteWaitMs: 2000 };
}
