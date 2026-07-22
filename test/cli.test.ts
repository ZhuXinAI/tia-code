import assert from "node:assert/strict";
import test from "node:test";
import { parseTiaCodeCommand } from "../src/cli.js";

test("opens the interactive app when no command is supplied", () => {
  assert.deepEqual(parseTiaCodeCommand([]), { type: "interactive" });
});

test("parses a quoted non-interactive prompt", () => {
  assert.deepEqual(parseTiaCodeCommand(["run", "doing stuff"]), {
    type: "run",
    prompt: "doing stuff",
  });
});

test("accepts an unquoted multi-word non-interactive prompt", () => {
  assert.deepEqual(parseTiaCodeCommand(["run", "do", "the", "thing"]), {
    type: "run",
    prompt: "do the thing",
  });
});

test("keeps resume in the interactive mode", () => {
  assert.deepEqual(parseTiaCodeCommand(["resume", "session-123"]), {
    type: "interactive",
    resumeSessionId: "session-123",
  });
});

test("rejects an empty non-interactive prompt", () => {
  assert.throws(() => parseTiaCodeCommand(["run"]), /Usage:\n  tia-code/);
});
