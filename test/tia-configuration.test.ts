import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadTiaConfiguration,
  resolveTiaConfiguration,
  saveTiaConfiguration,
  type TiaConfiguration,
} from "../src/tia-configuration.js";

const withTemporaryConfiguration = async (run: (path: string, directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "tia-code-config-"));
  try {
    await run(join(directory, "config.json"), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("persists custom provider endpoint and reasoning effort with protected permissions", async () => {
  await withTemporaryConfiguration(async (path, directory) => {
    await saveTiaConfiguration(
      {
        version: 1,
        providerId: "custom",
        apiKey: "test-key",
        modelId: "test-model",
        baseUrl: "https://llm.example.test/v1",
        reasoningEffort: "high",
      },
      path,
    );

    assert.deepEqual(await loadTiaConfiguration(path), {
      version: 1,
      providerId: "custom",
      apiKey: "test-key",
      modelId: "test-model",
      baseUrl: "https://llm.example.test/v1",
      reasoningEffort: "high",
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  });
});

test("keeps existing configurations compatible by defaulting reasoning effort", async () => {
  await withTemporaryConfiguration(async (path) => {
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        providerId: "opencode-go",
        apiKey: "test-key",
        modelId: "mimo-v2.5",
      })}\n`,
      "utf8",
    );

    assert.deepEqual(await loadTiaConfiguration(path), {
      version: 1,
      providerId: "opencode-go",
      apiKey: "test-key",
      modelId: "mimo-v2.5",
      reasoningEffort: "medium",
    });
  });
});

test("resolves one-shot overrides without leaking a previous provider base URL", () => {
  const saved: TiaConfiguration = {
    version: 1,
    providerId: "opencode-go",
    apiKey: "saved-key",
    modelId: "mimo-v2.5",
    baseUrl: "https://proxy.example.test/v1",
    reasoningEffort: "low",
  };

  assert.deepEqual(resolveTiaConfiguration(saved, { modelId: "another-model", reasoningEffort: "high" }), {
    ...saved,
    modelId: "another-model",
    reasoningEffort: "high",
  });
  assert.deepEqual(
    resolveTiaConfiguration(saved, {
      providerId: "openai",
      apiKey: "run-key",
      modelId: "gpt-5-mini",
    }),
    {
      version: 1,
      providerId: "openai",
      apiKey: "run-key",
      modelId: "gpt-5-mini",
      reasoningEffort: "low",
    },
  );
  assert.equal(
    resolveTiaConfiguration(saved, {
      providerId: "custom",
      apiKey: "run-key",
      modelId: "custom-model",
    }),
    null,
  );
});
