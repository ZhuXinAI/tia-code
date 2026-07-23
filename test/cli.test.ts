import assert from "node:assert/strict";
import test from "node:test";
import { parseTiaCodeCommand } from "../src/cli.js";

const parse = (args: readonly string[], environment: NodeJS.ProcessEnv = {}) =>
  parseTiaCodeCommand(args, environment);

test("opens the interactive app when no command is supplied", () => {
  assert.deepEqual(parse([]), { type: "interactive" });
});

test("reopens the setup flow when no setup inputs are supplied", () => {
  assert.deepEqual(parse(["setup"]), { type: "setup" });
});

test("parses non-interactive setup options in any order", () => {
  assert.deepEqual(
    parse([
      "setup",
      "--model-id=mimo-v2.5",
      "--reasoning-effort",
      "high",
      "--api-key",
      "test-key",
      "--provider",
      "opencode-go",
    ]),
    {
      type: "setup",
      configuration: {
        providerId: "opencode-go",
        apiKey: "test-key",
        modelId: "mimo-v2.5",
        reasoningEffort: "high",
      },
    },
  );
});

test("reads setup values from the TIA_CODE environment and lets flags win", () => {
  const environment = {
    TIA_CODE_PROVIDER: "opencode-go",
    TIA_CODE_API_KEY: "env-key",
    TIA_CODE_MODEL_ID: "mimo-v2.5",
    TIA_CODE_BASE_URL: "https://proxy.example.test/v1",
    TIA_CODE_REASONING_EFFORT: "low",
  };
  assert.deepEqual(parse(["setup"], environment), {
    type: "setup",
    configuration: {
      providerId: "opencode-go",
      apiKey: "env-key",
      modelId: "mimo-v2.5",
      baseUrl: "https://proxy.example.test/v1",
      reasoningEffort: "low",
    },
  });
  assert.deepEqual(parse(["setup", "--model-id", "flag-model"], environment), {
    type: "setup",
    configuration: {
      providerId: "opencode-go",
      apiKey: "env-key",
      modelId: "flag-model",
      baseUrl: "https://proxy.example.test/v1",
      reasoningEffort: "low",
    },
  });
});

test("requires a base URL for custom setup", () => {
  assert.throws(
    () =>
      parse([
        "setup",
        "--provider",
        "custom",
        "--api-key",
        "test-key",
        "--model-id",
        "test-model",
      ]),
    /Custom providers require --base-url or TIA_CODE_BASE_URL/,
  );
  assert.deepEqual(
    parse([
      "setup",
      "--provider",
      "custom",
      "--base-url",
      "https://llm.example.test/v1",
      "--api-key",
      "test-key",
      "--model-id",
      "test-model",
    ]),
    {
      type: "setup",
      configuration: {
        providerId: "custom",
        baseUrl: "https://llm.example.test/v1",
        apiKey: "test-key",
        modelId: "test-model",
        reasoningEffort: "medium",
      },
    },
  );
});

test("requires every primary value for non-interactive setup", () => {
  assert.throws(
    () => parse(["setup", "--provider", "opencode-go", "--api-key", "test-key"]),
    /Non-interactive setup requires a provider, API key, and model ID/,
  );
});

test("rejects invalid setup values and unknown options", () => {
  assert.throws(
    () =>
      parse([
        "setup",
        "--provider",
        "unknown",
        "--api-key",
        "test-key",
        "--model-id",
        "test-model",
      ]),
    /Unsupported provider: unknown/,
  );
  assert.throws(
    () => parse(["setup", "--base-url", "not-a-url"]),
    /must be an http\(s\) URL/,
  );
  assert.throws(
    () => parse(["setup", "--reasoning-effort", "maximum"]),
    /must be off, minimal, low, medium, or high/,
  );
  assert.throws(
    () => parse(["setup", "--unknown", "value"]),
    /Unknown connection option: --unknown/,
  );
});

test("parses a quoted non-interactive prompt", () => {
  assert.deepEqual(parse(["run", "doing stuff"]), {
    type: "run",
    prompt: "doing stuff",
  });
});

test("accepts an unquoted multi-word non-interactive prompt", () => {
  assert.deepEqual(parse(["run", "do", "the", "thing"]), {
    type: "run",
    prompt: "do the thing",
  });
});

test("applies run connection options only to the parsed invocation", () => {
  assert.deepEqual(
    parse([
      "run",
      "Summarize",
      "this",
      "repository.",
      "--model-id",
      "mimo-v2.5",
      "--reasoning-effort",
      "high",
    ]),
    {
      type: "run",
      prompt: "Summarize this repository.",
      configuration: {
        modelId: "mimo-v2.5",
        reasoningEffort: "high",
      },
    },
  );
});

test("reads run connection values from the environment and lets flags win", () => {
  const environment = {
    TIA_CODE_PROVIDER: "custom",
    TIA_CODE_API_KEY: "env-key",
    TIA_CODE_MODEL_ID: "env-model",
    TIA_CODE_BASE_URL: "https://llm.example.test/v1",
    TIA_CODE_REASONING_EFFORT: "medium",
  };
  assert.deepEqual(parse(["run", "hello"], environment), {
    type: "run",
    prompt: "hello",
    configuration: {
      providerId: "custom",
      apiKey: "env-key",
      modelId: "env-model",
      baseUrl: "https://llm.example.test/v1",
      reasoningEffort: "medium",
    },
  });
  assert.deepEqual(parse(["run", "hello", "--reasoning-effort", "high"], environment), {
    type: "run",
    prompt: "hello",
    configuration: {
      providerId: "custom",
      apiKey: "env-key",
      modelId: "env-model",
      baseUrl: "https://llm.example.test/v1",
      reasoningEffort: "high",
    },
  });
});

test("requires an explicit base URL when custom is selected for a run", () => {
  assert.throws(
    () => parse(["run", "hello", "--provider", "custom"]),
    /Custom providers require --base-url or TIA_CODE_BASE_URL/,
  );
});

test("keeps resume in the interactive mode", () => {
  assert.deepEqual(parse(["resume", "session-123"]), {
    type: "interactive",
    resumeSessionId: "session-123",
  });
});

test("parses MCP commands without opening the interactive app", () => {
  assert.deepEqual(parse(["mcp", "add", "stripe", "--url", "https://mcp.stripe.com"]), {
    type: "mcp",
    args: ["add", "stripe", "--url", "https://mcp.stripe.com"],
  });
});

test("rejects an empty non-interactive prompt", () => {
  assert.throws(() => parse(["run"]), /Usage:\n  tia-code/);
});
