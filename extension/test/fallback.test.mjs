import test from "node:test";
import assert from "node:assert/strict";
import { doneStatus, describeError, FALLBACK_NOTE } from "../lib/controller.js";

test("done status names Claude when it stood in for Codex", () => {
  assert.equal(doneStatus({ state: "done", mode: "codex-dip", answered_mode: "claude-dip" }), `Done. ${FALLBACK_NOTE}`);
  assert.equal(doneStatus({ state: "done", mode: "codex-dip", answered_mode: null }), "Done.");
  assert.equal(doneStatus({ state: "done", mode: "claude-dip" }), "Done.");
});

test("an outage error reads plainly", () => {
  assert.match(describeError("provider_unavailable", "Reconnecting... 503"), /down right now/);
});
