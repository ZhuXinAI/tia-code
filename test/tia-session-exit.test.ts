import assert from "node:assert/strict";
import test from "node:test";
import { formatTiaSessionExitSummary, type TiaSessionExitSummary } from "../src/tia-session-exit.js";

test("prints the installed CLI command for resuming a saved session", () => {
  const summary = {
    stats: {
      assistantMessages: 1,
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    },
    resumeSessionId: "session-123",
  } as TiaSessionExitSummary;

  const output = formatTiaSessionExitSummary(summary);
  assert.match(output ?? "", /run tia-code resume session-123/);
  assert.doesNotMatch(output ?? "", /pnpm run dev/);
});
