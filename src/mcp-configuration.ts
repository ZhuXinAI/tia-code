import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthTokens,
} from "@ai-sdk/mcp";
import { tiaConfigurationPath } from "./tia-configuration.js";

const MCP_CONFIGURATION_VERSION = 1;

export type TiaMcpOAuthState = {
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
  clientInformation?: OAuthClientInformation;
  authorizationServerInformation?: OAuthAuthorizationServerInformation;
  redirectUrl?: string;
};

export type TiaMcpServer = {
  name: string;
  transport:
    | {
        type: "http" | "sse";
        url: string;
        bearerTokenEnvVar?: string;
      }
    | {
        type: "stdio";
        command: string;
        args: string[];
        envVars: string[];
        cwd?: string;
      };
  oauth?: TiaMcpOAuthState;
};

export type TiaMcpConfiguration = {
  version: typeof MCP_CONFIGURATION_VERSION;
  servers: TiaMcpServer[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const validEnvironmentVariable = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const stringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
};

const httpUrl = (value: unknown): string | undefined => {
  const candidate = nonEmptyString(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const loopbackRedirectUrl = (value: unknown): string | undefined => {
  const candidate = httpUrl(value);
  if (!candidate) return undefined;
  const url = new URL(candidate);
  return url.protocol === "http:" && url.hostname === "127.0.0.1" ? url.href : undefined;
};

export const isTiaMcpServerName = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);

const normalizeTokens = (value: unknown): OAuthTokens | undefined => {
  if (!isRecord(value)) return undefined;
  const accessToken = nonEmptyString(value.access_token);
  const tokenType = nonEmptyString(value.token_type);
  if (!accessToken || !tokenType) return undefined;

  const result: OAuthTokens = { access_token: accessToken, token_type: tokenType };
  const idToken = nonEmptyString(value.id_token);
  const refreshToken = nonEmptyString(value.refresh_token);
  const scope = nonEmptyString(value.scope);
  const authorizationServer = httpUrl(value.authorization_server);
  const tokenEndpoint = httpUrl(value.token_endpoint);
  if (idToken) result.id_token = idToken;
  if (refreshToken) result.refresh_token = refreshToken;
  if (scope) result.scope = scope;
  if (typeof value.expires_in === "number" && Number.isFinite(value.expires_in)) {
    result.expires_in = value.expires_in;
  }
  if (authorizationServer) result.authorization_server = authorizationServer;
  if (tokenEndpoint) result.token_endpoint = tokenEndpoint;
  return result;
};

const normalizeClientInformation = (value: unknown): OAuthClientInformation | undefined => {
  if (!isRecord(value)) return undefined;
  const clientId = nonEmptyString(value.client_id);
  if (!clientId) return undefined;

  const result: OAuthClientInformation = { client_id: clientId };
  const clientSecret = nonEmptyString(value.client_secret);
  const authorizationServer = httpUrl(value.authorization_server);
  const tokenEndpoint = httpUrl(value.token_endpoint);
  if (clientSecret) result.client_secret = clientSecret;
  if (typeof value.client_id_issued_at === "number" && Number.isFinite(value.client_id_issued_at)) {
    result.client_id_issued_at = value.client_id_issued_at;
  }
  if (
    typeof value.client_secret_expires_at === "number" &&
    Number.isFinite(value.client_secret_expires_at)
  ) {
    result.client_secret_expires_at = value.client_secret_expires_at;
  }
  if (authorizationServer) result.authorization_server = authorizationServer;
  if (tokenEndpoint) result.token_endpoint = tokenEndpoint;
  return result;
};

const normalizeAuthorizationServerInformation = (
  value: unknown,
): OAuthAuthorizationServerInformation | undefined => {
  if (!isRecord(value)) return undefined;
  const authorizationServerUrl = httpUrl(value.authorizationServerUrl);
  const tokenEndpoint = httpUrl(value.tokenEndpoint);
  if (!authorizationServerUrl || !tokenEndpoint) return undefined;
  return { authorizationServerUrl, tokenEndpoint };
};

const normalizeOAuthState = (value: unknown): TiaMcpOAuthState | undefined => {
  if (!isRecord(value)) return undefined;
  const state: TiaMcpOAuthState = {};
  const tokens = normalizeTokens(value.tokens);
  const codeVerifier = nonEmptyString(value.codeVerifier);
  const callbackState = nonEmptyString(value.state);
  const clientInformation = normalizeClientInformation(value.clientInformation);
  const authorizationServerInformation = normalizeAuthorizationServerInformation(
    value.authorizationServerInformation,
  );
  const redirectUrl = loopbackRedirectUrl(value.redirectUrl);
  if (tokens) state.tokens = tokens;
  if (codeVerifier) state.codeVerifier = codeVerifier;
  if (callbackState) state.state = callbackState;
  if (clientInformation) state.clientInformation = clientInformation;
  if (authorizationServerInformation) {
    state.authorizationServerInformation = authorizationServerInformation;
  }
  if (redirectUrl) state.redirectUrl = redirectUrl;
  return Object.keys(state).length > 0 ? state : undefined;
};

const normalizeServer = (value: unknown): TiaMcpServer | undefined => {
  if (!isRecord(value)) return undefined;
  const name = nonEmptyString(value.name);
  if (!name || !isTiaMcpServerName(name) || !isRecord(value.transport)) return undefined;

  const oauth = normalizeOAuthState(value.oauth);
  if (value.oauth !== undefined && !oauth) return undefined;
  const type = value.transport.type;
  if (type === "http" || type === "sse") {
    const url = httpUrl(value.transport.url);
    const bearerTokenEnvVar = nonEmptyString(value.transport.bearerTokenEnvVar);
    if (!url || (bearerTokenEnvVar && !validEnvironmentVariable(bearerTokenEnvVar))) {
      return undefined;
    }
    return {
      name,
      transport: { type, url, ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}) },
      ...(oauth ? { oauth } : {}),
    };
  }

  if (type !== "stdio") return undefined;
  const command = nonEmptyString(value.transport.command);
  const args = stringList(value.transport.args) ?? [];
  const envVars = stringList(value.transport.envVars) ?? [];
  const cwd = nonEmptyString(value.transport.cwd);
  if (!command || !envVars.every(validEnvironmentVariable)) return undefined;
  return {
    name,
    transport: { type, command, args, envVars, ...(cwd ? { cwd } : {}) },
    ...(oauth ? { oauth } : {}),
  };
};

const normalizeConfiguration = (value: unknown): TiaMcpConfiguration | undefined => {
  if (!isRecord(value) || value.version !== MCP_CONFIGURATION_VERSION || !Array.isArray(value.servers)) {
    return undefined;
  }
  const servers = value.servers.map(normalizeServer);
  if (servers.some((server) => !server)) return undefined;
  const normalizedServers = servers as TiaMcpServer[];
  if (new Set(normalizedServers.map((server) => server.name)).size !== normalizedServers.length) {
    return undefined;
  }
  return { version: MCP_CONFIGURATION_VERSION, servers: normalizedServers };
};

const emptyConfiguration = (): TiaMcpConfiguration => ({ version: MCP_CONFIGURATION_VERSION, servers: [] });

export const tiaMcpConfigurationPath = (): string =>
  join(dirname(tiaConfigurationPath()), "mcp.json");

export const loadTiaMcpConfiguration = async (
  path = tiaMcpConfigurationPath(),
): Promise<TiaMcpConfiguration> => {
  try {
    const configuration = normalizeConfiguration(JSON.parse(await readFile(path, "utf8")));
    if (!configuration) throw new Error("invalid configuration");
    return configuration;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConfiguration();
    throw new Error("TIA MCP configuration could not be read.");
  }
};

export const saveTiaMcpConfiguration = async (
  configuration: TiaMcpConfiguration,
  path = tiaMcpConfigurationPath(),
): Promise<TiaMcpConfiguration> => {
  const normalized = normalizeConfiguration(configuration);
  if (!normalized) throw new Error("TIA MCP configuration is invalid.");

  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return normalized;
};

export const saveTiaMcpServer = async (
  server: TiaMcpServer,
  path = tiaMcpConfigurationPath(),
): Promise<TiaMcpServer> => {
  const normalized = normalizeServer(server);
  if (!normalized) throw new Error("TIA MCP server configuration is invalid.");
  const configuration = await loadTiaMcpConfiguration(path);
  const index = configuration.servers.findIndex((candidate) => candidate.name === normalized.name);
  const servers = [...configuration.servers];
  if (index === -1) servers.push(normalized);
  else servers[index] = normalized;
  await saveTiaMcpConfiguration({ ...configuration, servers }, path);
  return normalized;
};

export const updateTiaMcpServer = async (
  name: string,
  update: (server: TiaMcpServer) => TiaMcpServer | undefined,
  path = tiaMcpConfigurationPath(),
): Promise<TiaMcpServer | undefined> => {
  const configuration = await loadTiaMcpConfiguration(path);
  const index = configuration.servers.findIndex((server) => server.name === name);
  if (index === -1) return undefined;

  const next = update(configuration.servers[index]!);
  const servers = [...configuration.servers];
  if (!next) {
    servers.splice(index, 1);
    await saveTiaMcpConfiguration({ ...configuration, servers }, path);
    return undefined;
  }

  const normalized = normalizeServer(next);
  if (!normalized) throw new Error("TIA MCP server configuration is invalid.");
  servers[index] = normalized;
  await saveTiaMcpConfiguration({ ...configuration, servers }, path);
  return normalized;
};

export const removeTiaMcpServer = async (
  name: string,
  path = tiaMcpConfigurationPath(),
): Promise<TiaMcpServer | undefined> => {
  const configuration = await loadTiaMcpConfiguration(path);
  const index = configuration.servers.findIndex((server) => server.name === name);
  if (index === -1) return undefined;
  const [removed] = configuration.servers.splice(index, 1);
  await saveTiaMcpConfiguration(configuration, path);
  return removed;
};
