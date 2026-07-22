import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadTiaMcpConfiguration,
  removeTiaMcpServer,
  saveTiaMcpServer,
  updateTiaMcpServer,
} from "../src/mcp-configuration.js";

const withTemporaryConfiguration = async (
  run: (path: string, directory: string) => Promise<void>,
): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "tia-code-mcp-"));
  try {
    await run(join(directory, "mcp.json"), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("persists an MCP server and protects its configuration file", async () => {
  await withTemporaryConfiguration(async (path, directory) => {
    await saveTiaMcpServer(
      {
        name: "issue-tracker",
        transport: {
          type: "http",
          url: "https://mcp.example.test/tools",
          bearerTokenEnvVar: "ISSUE_TRACKER_TOKEN",
        },
        oauth: {
          tokens: { access_token: "test-token", token_type: "Bearer" },
          redirectUrl: "http://127.0.0.1:43123/oauth/callback",
        },
      },
      path,
    );

    assert.deepEqual(await loadTiaMcpConfiguration(path), {
      version: 1,
      servers: [
        {
          name: "issue-tracker",
          transport: {
            type: "http",
            url: "https://mcp.example.test/tools",
            bearerTokenEnvVar: "ISSUE_TRACKER_TOKEN",
          },
          oauth: {
            tokens: { access_token: "test-token", token_type: "Bearer" },
            redirectUrl: "http://127.0.0.1:43123/oauth/callback",
          },
        },
      ],
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  });
});

test("updates and removes only the requested MCP server", async () => {
  await withTemporaryConfiguration(async (path) => {
    await saveTiaMcpServer(
      {
        name: "local-tools",
        transport: {
          type: "stdio",
          command: "node",
          args: ["server.mjs"],
          envVars: ["LOCAL_TOOL_KEY"],
        },
      },
      path,
    );
    await saveTiaMcpServer(
      {
        name: "remote-tools",
        transport: { type: "sse", url: "https://mcp.example.test/sse" },
        oauth: { tokens: { access_token: "test-token", token_type: "Bearer" } },
      },
      path,
    );

    const updated = await updateTiaMcpServer(
      "remote-tools",
      (server) => {
        const { oauth: _oauth, ...withoutOAuth } = server;
        return withoutOAuth;
      },
      path,
    );
    assert.ok(updated);
    assert.equal(updated.oauth, undefined);
    assert.equal((await loadTiaMcpConfiguration(path)).servers.length, 2);

    const removed = await removeTiaMcpServer("local-tools", path);
    assert.equal(removed?.name, "local-tools");
    assert.deepEqual(
      (await loadTiaMcpConfiguration(path)).servers.map((server) => server.name),
      ["remote-tools"],
    );
  });
});

test("rejects invalid MCP configuration", async () => {
  await withTemporaryConfiguration(async (path) => {
    await assert.rejects(
      saveTiaMcpServer(
        {
          name: "contains spaces",
          transport: { type: "http", url: "https://mcp.example.test" },
        },
        path,
      ),
      /invalid/,
    );
    await assert.rejects(
      saveTiaMcpServer(
        {
          name: "bad-url",
          transport: { type: "http", url: "file:///not-an-mcp-server" },
        },
        path,
      ),
      /invalid/,
    );
    await assert.rejects(
      saveTiaMcpServer(
        {
          name: "bad-redirect",
          transport: { type: "http", url: "https://mcp.example.test" },
          oauth: { redirectUrl: "https://not-a-loopback-callback.example.test" },
        },
        path,
      ),
      /invalid/,
    );
  });
});
