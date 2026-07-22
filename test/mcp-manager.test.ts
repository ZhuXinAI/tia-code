import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadTiaMcpConfiguration, saveTiaMcpServer } from "../src/mcp-configuration.js";
import { McpManager, parseMcpAddArguments } from "../src/mcp-manager.js";

const withTemporaryManager = async (run: (manager: McpManager, path: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "tia-code-mcp-manager-"));
  const path = join(directory, "mcp.json");
  try {
    await run(new McpManager({ configurationPath: path }), path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const stdioFixture = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));

test("parses remote and local MCP add commands without accepting raw secrets", () => {
  assert.deepEqual(parseMcpAddArguments(["remote", "--url", "https://mcp.example.test", "--bearer-token-env", "MCP_TOKEN"]), {
    name: "remote",
    transport: {
      type: "http",
      url: "https://mcp.example.test/",
      bearerTokenEnvVar: "MCP_TOKEN",
    },
  });
  assert.deepEqual(parseMcpAddArguments(["local", "--env", "LOCAL_TOKEN", "--", "node", "server.mjs"]), {
    name: "local",
    transport: {
      type: "stdio",
      command: "node",
      args: ["server.mjs"],
      envVars: ["LOCAL_TOKEN"],
    },
  });
  assert.throws(
    () => parseMcpAddArguments(["remote", "--url", "https://mcp.example.test", "--token", "secret"]),
    /Unknown MCP add option/,
  );
});

test("adds, logs out, and removes a TIA-owned MCP configuration", async () => {
  await withTemporaryManager(async (manager, path) => {
    const added = await manager.executeSlashCommand([
      "add",
      "remote",
      "--sse",
      "https://mcp.example.test/sse",
    ]);
    assert.equal(added.tone, "success");
    assert.equal((await loadTiaMcpConfiguration(path)).servers[0]?.name, "remote");

    await saveTiaMcpServer(
      {
        name: "oauth-server",
        transport: { type: "http", url: "https://mcp.example.test/oauth" },
        oauth: { tokens: { access_token: "test-token", token_type: "Bearer" } },
      },
      path,
    );
    const loggedOut = await manager.executeSlashCommand(["logout", "oauth-server"]);
    assert.equal(loggedOut.tone, "success");
    assert.equal(
      (await loadTiaMcpConfiguration(path)).servers.find((server) => server.name === "oauth-server")?.oauth,
      undefined,
    );

    const needsConfirmation = await manager.executeSlashCommand(["remove", "remote"]);
    assert.equal(needsConfirmation.tone, "error");
    assert.equal((await loadTiaMcpConfiguration(path)).servers.some((server) => server.name === "remote"), true);

    const removed = await manager.executeSlashCommand(["remove", "remote", "--confirm"]);
    assert.equal(removed.tone, "success");
    assert.equal((await loadTiaMcpConfiguration(path)).servers.some((server) => server.name === "remote"), false);
    await manager.dispose();
  });
});

test("connects to a local stdio MCP server through the AI SDK client", async () => {
  await withTemporaryManager(async (manager, path) => {
    await saveTiaMcpServer(
      {
        name: "local",
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [stdioFixture],
          envVars: [],
        },
      },
      path,
    );

    try {
      const connection = await manager.connect("local");
      assert.deepEqual(connection.tools.map((tool) => tool.name), ["echo"]);
      assert.equal(await manager.disconnect("local"), true);
    } finally {
      await manager.dispose();
    }
  });
});
