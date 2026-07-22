import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadTiaMcpConfiguration, saveTiaMcpServer } from "../src/mcp-configuration.js";
import { McpManager, parseMcpAddArguments } from "../src/mcp-manager.js";

const withTemporaryManager = async (run: (manager: McpManager, path: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "tia-code-mcp-manager-"));
  const path = join(directory, "mcp.json");
  const manager = new McpManager({ configurationPath: path });
  try {
    await run(manager, path);
  } finally {
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
};

const stdioFixture = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));

const json = (response: ServerResponse, body: unknown, status = 200): void => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
};

const readRequestBody = async (request: IncomingMessage): Promise<string> => {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
};

const startOAuthMcpServer = async ({ failTokenExchange = false }: { failTokenExchange?: boolean } = {}) => {
  let origin = "";
  let unauthenticatedPostCount = 0;
  let initializeCount = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      json(response, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(response, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const registration = JSON.parse(await readRequestBody(request)) as { redirect_uris?: string[] };
      json(response, { client_id: "test-client", redirect_uris: registration.redirect_uris ?? [] }, 201);
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      await readRequestBody(request);
      if (failTokenExchange) {
        json(response, { error: "invalid_grant" }, 400);
        return;
      }
      json(response, { access_token: "test-access-token", token_type: "Bearer" });
      return;
    }
    if (url.pathname === "/mcp" && request.method === "GET") {
      response.statusCode = 405;
      response.end();
      return;
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      const message = JSON.parse(await readRequestBody(request)) as {
        id?: string | number | null;
        method?: string;
        params?: { protocolVersion?: string };
      };
      if (request.headers.authorization !== "Bearer test-access-token") {
        unauthenticatedPostCount += 1;
        response.statusCode = 401;
        response.setHeader(
          "www-authenticate",
          `Bearer resource_metadata=\"${origin}/.well-known/oauth-protected-resource\"`,
        );
        response.end();
        return;
      }
      if (message.method === "initialize") {
        initializeCount += 1;
        json(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "test-oauth-mcp", version: "1.0.0" },
          },
        });
        return;
      }
      if (message.method === "notifications/initialized") {
        response.statusCode = 202;
        response.end();
        return;
      }
      if (message.method === "tools/list") {
        json(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "authenticated_echo",
                description: "Echoes authenticated input.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
        return;
      }
    }

    response.statusCode = 404;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth MCP test server did not bind to a port.");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    unauthenticatedPostCount: () => unauthenticatedPostCount,
    initializeCount: () => initializeCount,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};

const completeAuthorization = async (authorizationUrl: URL): Promise<void> => {
  const redirectUrl = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
  redirectUrl.searchParams.set("code", "test-code");
  redirectUrl.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
  const response = await fetch(redirectUrl);
  assert.equal(response.status, 200);
};

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
      "local",
      "--",
      process.execPath,
      stdioFixture,
    ]);
    assert.equal(added.tone, "success", added.lines.join("\n"));
    assert.equal((await loadTiaMcpConfiguration(path)).servers[0]?.name, "local");

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

    const needsConfirmation = await manager.executeSlashCommand(["remove", "local"]);
    assert.equal(needsConfirmation.tone, "error");
    assert.equal((await loadTiaMcpConfiguration(path)).servers.some((server) => server.name === "local"), true);

    const removed = await manager.executeSlashCommand(["remove", "local", "--confirm"]);
    assert.equal(removed.tone, "success");
    assert.equal((await loadTiaMcpConfiguration(path)).servers.some((server) => server.name === "local"), false);
  });
});

test("adds an OAuth MCP server by connecting, signing in once, and retrying", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tia-code-mcp-oauth-add-"));
  const path = join(directory, "mcp.json");
  const oauthMcp = await startOAuthMcpServer();
  let authorizationCount = 0;
  const manager = new McpManager({
    configurationPath: path,
    oauthLoginOptions: {
      onAuthorizationUrl: async (authorizationUrl) => {
        authorizationCount += 1;
        await completeAuthorization(authorizationUrl);
      },
    },
  });
  try {
    const added = await manager.executeSlashCommand(["add", "oauth", "--url", `${oauthMcp.origin}/mcp`]);
    assert.equal(added.tone, "success", added.lines.join("\n"));
    assert.match(added.lines.join("\n"), /signed in and retried once/i);
    assert.equal(authorizationCount, 1);
    assert.equal(oauthMcp.unauthenticatedPostCount(), 1);
    const tokens = (await loadTiaMcpConfiguration(path)).servers[0]?.oauth?.tokens;
    assert.equal(tokens?.access_token, "test-access-token");
    assert.equal(tokens?.token_type, "Bearer");
    assert.equal((await manager.listServers())[0]?.connection, "connected");
  } finally {
    await manager.dispose();
    await oauthMcp.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("auto-connects saved OAuth MCP servers with complete sign-in and skips incomplete sign-in", async () => {
  const oauthMcp = await startOAuthMcpServer();
  try {
    await withTemporaryManager(async (manager, path) => {
      await saveTiaMcpServer(
        {
          name: "ready",
          transport: { type: "http", url: `${oauthMcp.origin}/mcp` },
          oauth: { tokens: { access_token: "test-access-token", token_type: "Bearer" } },
        },
        path,
      );
      await saveTiaMcpServer(
        {
          name: "needs-login",
          transport: { type: "http", url: `${oauthMcp.origin}/mcp` },
          oauth: { clientInformation: { client_id: "test-client" } },
        },
        path,
      );

      await manager.connectOnStartup();

      const servers = await manager.listServers();
      assert.equal(servers.find((server) => server.name === "ready")?.connection, "connected");
      assert.equal(servers.find((server) => server.name === "needs-login")?.connection, "disconnected");
      assert.equal(oauthMcp.unauthenticatedPostCount(), 0);
      assert.equal(oauthMcp.initializeCount(), 1);

      const refreshed = await manager.executeSlashCommand(["connect", "ready"]);
      assert.equal(refreshed.title, "Refreshed MCP · ready");
      assert.equal(oauthMcp.initializeCount(), 2);
    });
  } finally {
    await oauthMcp.close();
  }
});

test("reports an error when automatic OAuth sign-in cannot complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tia-code-mcp-oauth-add-failure-"));
  const path = join(directory, "mcp.json");
  const oauthMcp = await startOAuthMcpServer({ failTokenExchange: true });
  const manager = new McpManager({
    configurationPath: path,
    oauthLoginOptions: { onAuthorizationUrl: completeAuthorization },
  });
  try {
    const added = await manager.executeSlashCommand(["add", "oauth", "--url", `${oauthMcp.origin}/mcp`]);
    assert.equal(added.tone, "error");
    assert.match(added.lines.join("\n"), /Automatic OAuth sign-in failed/);
    assert.equal((await loadTiaMcpConfiguration(path)).servers[0]?.name, "oauth");
    assert.equal(oauthMcp.unauthenticatedPostCount(), 1);
  } finally {
    await manager.dispose();
    await oauthMcp.close();
    await rm(directory, { recursive: true, force: true });
  }
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

    const connection = await manager.connect("local");
    assert.deepEqual(connection.tools.map((tool) => tool.name), ["echo"]);
    assert.equal(await manager.disconnect("local"), true);
  });
});
