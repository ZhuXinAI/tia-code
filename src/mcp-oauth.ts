import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  auth,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import {
  loadTiaMcpConfiguration,
  type TiaMcpOAuthState,
  type TiaMcpServer,
  updateTiaMcpServer,
} from "./mcp-configuration.js";

const CALLBACK_PATH = "/oauth/callback";
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const BROWSER_OPEN_TIMEOUT_MS = 15_000;
const MAX_AUTHORIZATION_REDIRECTS = 3;

type OAuthCallback =
  | { code: string; state?: string }
  | { error: string; errorDescription?: string };

type PendingCallback = {
  resolve: (callback: OAuthCallback) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type OAuthCallbackServer = {
  redirectUrl: string;
  redirectUrlChanged: boolean;
  waitForCallback: () => Promise<OAuthCallback>;
  close: () => Promise<void>;
};

export type McpOAuthProviderOptions = {
  serverName: string;
  redirectUrl: string;
  configurationPath?: string;
  onAuthorizationUrl: (url: URL) => Promise<void> | void;
};

export type McpLoginOptions = {
  onAuthorizationUrl?: McpOAuthProviderOptions["onAuthorizationUrl"];
};

const CLIENT_METADATA = (redirectUrl: string): OAuthClientMetadata => ({
  redirect_uris: [redirectUrl],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  client_name: "TIA Code",
});

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "The operation failed.";

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "127.0.0.1" ||
  hostname === "localhost" ||
  hostname === "::1" ||
  hostname === "[::1]";

const isSafeOAuthUrl = (url: URL): boolean =>
  url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));

const parsePreferredCallbackPort = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== CALLBACK_PATH ||
      !url.port
    ) {
      return undefined;
    }
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
  } catch {
    return undefined;
  }
};

const respondToCallback = (response: ServerResponse, success: boolean) => {
  response.statusCode = success ? 200 : 400;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html><body><p>${
    success ? "Sign-in complete. You can return to TIA Code." : "Sign-in could not be completed."
  }</p></body></html>`);
};

const closeServer = async (server: Server): Promise<void> =>
  new Promise((resolve) => {
    try {
      server.close(() => resolve());
      server.closeAllConnections();
    } catch {
      resolve();
    }
  });

const listen = async (server: Server, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

const startOAuthCallbackServer = async (
  preferredRedirectUrl: string | undefined,
): Promise<OAuthCallbackServer> => {
  const callbacks: OAuthCallback[] = [];
  let pending: PendingCallback | undefined;

  const deliver = (callback: OAuthCallback) => {
    if (!pending) {
      callbacks.push(callback);
      return;
    }
    clearTimeout(pending.timeout);
    const current = pending;
    pending = undefined;
    current.resolve(callback);
  };

  const requestListener = (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.end();
      return;
    }

    const callbackUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (callbackUrl.pathname !== CALLBACK_PATH) {
      response.statusCode = 404;
      response.end();
      return;
    }

    const error = callbackUrl.searchParams.get("error");
    if (error) {
      respondToCallback(response, false);
      deliver({
        error,
        ...(callbackUrl.searchParams.get("error_description")
          ? { errorDescription: callbackUrl.searchParams.get("error_description")! }
          : {}),
      });
      return;
    }

    const code = callbackUrl.searchParams.get("code");
    if (!code) {
      respondToCallback(response, false);
      deliver({ error: "missing_authorization_code" });
      return;
    }

    respondToCallback(response, true);
    deliver({
      code,
      ...(callbackUrl.searchParams.get("state")
        ? { state: callbackUrl.searchParams.get("state")! }
        : {}),
    });
  };

  const server = createServer(requestListener);
  const preferredPort = parsePreferredCallbackPort(preferredRedirectUrl);
  let redirectUrlChanged = !preferredPort;
  if (preferredPort) {
    try {
      await listen(server, preferredPort);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        await closeServer(server);
        throw error;
      }
      redirectUrlChanged = true;
      await listen(server, 0);
    }
  } else {
    await listen(server, 0);
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("TIA could not start the local OAuth callback server.");
  }
  const redirectUrl = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
  redirectUrlChanged ||= redirectUrl !== preferredRedirectUrl;

  return {
    redirectUrl,
    redirectUrlChanged,
    waitForCallback: () => {
      const callback = callbacks.shift();
      if (callback) return Promise.resolve(callback);
      return new Promise<OAuthCallback>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!pending) return;
          pending = undefined;
          reject(new Error("OAuth sign-in timed out. Run /mcp login again when you are ready."));
        }, OAUTH_CALLBACK_TIMEOUT_MS);
        pending = { resolve, reject, timeout };
      });
    },
    close: async () => {
      if (pending) {
        clearTimeout(pending.timeout);
        const current = pending;
        pending = undefined;
        current.reject(new Error("OAuth sign-in was closed."));
      }
      await closeServer(server);
    },
  };
};

const openSystemBrowser = async (url: URL): Promise<void> => {
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [url.href] }
      : process.platform === "win32"
        ? { executable: "cmd", args: ["/c", "start", "", url.href] }
        : { executable: "xdg-open", args: [url.href] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("TIA could not open your browser for OAuth sign-in."));
    }, BROWSER_OPEN_TIMEOUT_MS);
    child.once("error", () => finish(new Error("TIA could not open your browser for OAuth sign-in.")));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error("TIA could not open your browser for OAuth sign-in."));
    });
  });
};

const updateOAuthState = async (
  serverName: string,
  update: (current: TiaMcpOAuthState | undefined) => TiaMcpOAuthState | undefined,
  configurationPath?: string,
): Promise<TiaMcpServer> => {
  const updated = await updateTiaMcpServer(
    serverName,
    (server) => {
      const oauth = update(server.oauth);
      if (!oauth) {
        const { oauth: _oauth, ...withoutOAuth } = server;
        return withoutOAuth;
      }
      return { ...server, oauth };
    },
    configurationPath,
  );
  if (!updated) throw new Error(`No MCP server named "${serverName}" is configured.`);
  return updated;
};

const oauthStateFor = async (
  serverName: string,
  configurationPath?: string,
): Promise<TiaMcpOAuthState | undefined> => {
  const configuration = await loadTiaMcpConfiguration(configurationPath);
  const server = configuration.servers.find((candidate) => candidate.name === serverName);
  if (!server) throw new Error(`No MCP server named "${serverName}" is configured.`);
  return server.oauth;
};

const withoutTransientState = (state: TiaMcpOAuthState): TiaMcpOAuthState => {
  const { codeVerifier: _codeVerifier, state: _state, ...stable } = state;
  return stable;
};

const clearCredentials = (
  state: TiaMcpOAuthState | undefined,
  scope: "all" | "client" | "tokens" | "verifier",
): TiaMcpOAuthState | undefined => {
  if (!state || scope === "all") return undefined;
  const next = { ...state };
  if (scope === "client") {
    delete next.clientInformation;
    delete next.authorizationServerInformation;
    delete next.tokens;
  }
  if (scope === "tokens") delete next.tokens;
  if (scope === "verifier") {
    delete next.codeVerifier;
    delete next.state;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

export const createMcpOAuthProvider = ({
  serverName,
  redirectUrl,
  configurationPath,
  onAuthorizationUrl,
}: McpOAuthProviderOptions): OAuthClientProvider => ({
  tokens: async (): Promise<OAuthTokens | undefined> => (await oauthStateFor(serverName, configurationPath))?.tokens,
  saveTokens: async (tokens: OAuthTokens) => {
    await updateOAuthState(
      serverName,
      (current) => withoutTransientState({ ...(current ?? {}), tokens }),
      configurationPath,
    );
  },
  redirectToAuthorization: async (authorizationUrl: URL) => onAuthorizationUrl(authorizationUrl),
  saveCodeVerifier: async (codeVerifier: string) => {
    await updateOAuthState(
      serverName,
      (current) => ({ ...(current ?? {}), codeVerifier }),
      configurationPath,
    );
  },
  codeVerifier: async () => {
    const codeVerifier = (await oauthStateFor(serverName, configurationPath))?.codeVerifier;
    if (!codeVerifier) throw new Error("No OAuth sign-in is waiting for an authorization code.");
    return codeVerifier;
  },
  get redirectUrl() {
    return redirectUrl;
  },
  get clientMetadata() {
    return CLIENT_METADATA(redirectUrl);
  },
  clientInformation: async (): Promise<OAuthClientInformation | undefined> =>
    (await oauthStateFor(serverName, configurationPath))?.clientInformation,
  saveClientInformation: async (clientInformation: OAuthClientInformation) => {
    await updateOAuthState(
      serverName,
      (current) => ({ ...(current ?? {}), clientInformation }),
      configurationPath,
    );
  },
  authorizationServerInformation: async (): Promise<OAuthAuthorizationServerInformation | undefined> =>
    (await oauthStateFor(serverName, configurationPath))?.authorizationServerInformation,
  saveAuthorizationServerInformation: async (
    authorizationServerInformation: OAuthAuthorizationServerInformation,
  ) => {
    await updateOAuthState(
      serverName,
      (current) => ({ ...(current ?? {}), authorizationServerInformation }),
      configurationPath,
    );
  },
  validateAuthorizationServerURL: async (serverUrl, authorizationServerUrl) => {
    const resourceUrl = new URL(serverUrl.toString());
    const authorizationUrl = new URL(authorizationServerUrl.toString());
    if (!isSafeOAuthUrl(resourceUrl)) {
      throw new Error("MCP OAuth requires an HTTPS server URL (or a local loopback URL).");
    }
    if (!isSafeOAuthUrl(authorizationUrl)) {
      throw new Error("MCP OAuth requires an HTTPS authorization server (or a local loopback URL).");
    }
  },
  state: () => randomBytes(32).toString("base64url"),
  saveState: async (state: string) => {
    await updateOAuthState(serverName, (current) => ({ ...(current ?? {}), state }), configurationPath);
  },
  storedState: async (): Promise<string | undefined> =>
    (await oauthStateFor(serverName, configurationPath))?.state,
  invalidateCredentials: async (scope) => {
    await updateOAuthState(serverName, (current) => clearCredentials(current, scope), configurationPath);
  },
});

const isOAuthCallbackError = (callback: OAuthCallback): callback is Extract<OAuthCallback, { error: string }> =>
  "error" in callback;

export const loginToMcpServer = async (
  server: TiaMcpServer,
  configurationPath?: string,
  options: McpLoginOptions = {},
): Promise<void> => {
  if (server.transport.type === "stdio") {
    throw new Error(`"${server.name}" is a local stdio server and does not support browser OAuth.`);
  }
  if (server.transport.bearerTokenEnvVar) {
    throw new Error(`"${server.name}" uses an environment bearer token and does not need OAuth login.`);
  }

  const callbackServer = await startOAuthCallbackServer(server.oauth?.redirectUrl);
  try {
    if (callbackServer.redirectUrlChanged) {
      await updateOAuthState(
        server.name,
        () => ({ redirectUrl: callbackServer.redirectUrl }),
        configurationPath,
      );
    } else {
      await updateOAuthState(
        server.name,
        (current) => ({ ...(current ?? {}), redirectUrl: callbackServer.redirectUrl }),
        configurationPath,
      );
    }

    const provider = createMcpOAuthProvider({
      serverName: server.name,
      redirectUrl: callbackServer.redirectUrl,
      configurationPath,
      onAuthorizationUrl: options.onAuthorizationUrl ?? openSystemBrowser,
    });

    let result = await auth(provider, { serverUrl: server.transport.url });
    let redirects = 0;
    while (result === "REDIRECT") {
      redirects += 1;
      if (redirects > MAX_AUTHORIZATION_REDIRECTS) {
        throw new Error("OAuth sign-in redirected too many times. Run /mcp login again.");
      }
      const callback = await callbackServer.waitForCallback();
      if (isOAuthCallbackError(callback)) {
        const detail = callback.errorDescription ? `: ${callback.errorDescription}` : "";
        throw new Error(`OAuth sign-in was not completed (${callback.error})${detail}`);
      }
      result = await auth(provider, {
        serverUrl: server.transport.url,
        authorizationCode: callback.code,
        callbackState: callback.state,
      });
    }
  } catch (error) {
    throw new Error(`Could not sign in to "${server.name}": ${messageFromUnknown(error)}`);
  } finally {
    await callbackServer.close();
  }
};
