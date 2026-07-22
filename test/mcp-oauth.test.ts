import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTiaMcpConfiguration, saveTiaMcpServer } from "../src/mcp-configuration.js";
import { loginToMcpServer } from "../src/mcp-oauth.js";

const json = (response: import("node:http").ServerResponse, body: unknown, status = 200) => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
};

const startOAuthServer = async () => {
  let origin = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
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
      json(response, { client_id: "test-client", redirect_uris: [`${origin}/callback`] }, 201);
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      json(response, { access_token: "test-access-token", token_type: "Bearer", refresh_token: "test-refresh-token" });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test OAuth server did not bind to a port.");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};

test("completes browser OAuth through a local callback and stores credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tia-code-mcp-oauth-"));
  const configurationPath = join(directory, "mcp.json");
  const oauthServer = await startOAuthServer();
  try {
    const server = await saveTiaMcpServer(
      {
        name: "oauth",
        transport: { type: "http", url: `${oauthServer.origin}/mcp` },
      },
      configurationPath,
    );
    await loginToMcpServer(server, configurationPath, {
      onAuthorizationUrl: async (authorizationUrl) => {
        assert.equal(authorizationUrl.origin, oauthServer.origin);
        const redirectUrl = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
        redirectUrl.searchParams.set("code", "test-code");
        redirectUrl.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
        const response = await fetch(redirectUrl);
        assert.equal(response.status, 200);
      },
    });

    const saved = (await loadTiaMcpConfiguration(configurationPath)).servers[0]?.oauth;
    assert.equal(saved?.tokens?.access_token, "test-access-token");
    assert.equal(saved?.tokens?.refresh_token, "test-refresh-token");
    assert.equal(saved?.codeVerifier, undefined);
    assert.equal(saved?.state, undefined);
    assert.match(saved?.redirectUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
  } finally {
    await oauthServer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
