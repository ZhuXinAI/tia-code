import { createMCPClient, type CallToolResult, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  isTiaMcpServerName,
  loadTiaMcpConfiguration,
  removeTiaMcpServer,
  saveTiaMcpServer,
  type TiaMcpServer,
  updateTiaMcpServer,
} from "./mcp-configuration.js";
import { createMcpOAuthProvider, loginToMcpServer } from "./mcp-oauth.js";

type UnknownRecord = Record<string, unknown>;

type ConnectedMcpServer = {
  client: MCPClient;
  tools: McpToolSummary[];
};

type McpClientAttempt = {
  client: Promise<MCPClient>;
  abort: () => Promise<void>;
};

export type McpServerSummary = {
  name: string;
  transport: "stdio" | "http" | "sse";
  endpoint?: string;
  authStatus: string;
  connection: "connected" | "disconnected";
};

export type McpToolSummary = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpCommandResult = {
  title: string;
  lines: string[];
  tone?: "success" | "error" | "info";
};

export type McpManagerOptions = {
  configurationPath?: string;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 12_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_TOOL_OUTPUT_CHARS = 48_000;
const OAUTH_REAUTH_REDIRECT_URL = "http://127.0.0.1:0/oauth/callback";

const isRecord = (value: unknown): value is UnknownRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "The operation failed.";

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;

const isEnvironmentVariable = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const readMcpUrl = (value: string): string => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return url.href;
  } catch {
    throw new Error("MCP URLs must use http:// or https://.");
  }
};

const safeEndpoint = (server: TiaMcpServer): string | undefined => {
  if (server.transport.type === "stdio") return undefined;
  try {
    const url = new URL(server.transport.url);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "configured endpoint";
  }
};

const authenticationStatus = (server: TiaMcpServer): string => {
  if (server.transport.type !== "stdio" && server.transport.bearerTokenEnvVar) {
    return "environment token";
  }
  if (server.oauth?.tokens) return "OAuth signed in";
  if (server.oauth?.clientInformation) return "OAuth sign-in incomplete";
  return "no credentials configured";
};

const serializeResult = (result: unknown): string => {
  const value = isRecord(result) ? result : {};
  const content = (Array.isArray(value.content) ? value.content : []).map((part) => {
    if (!isRecord(part)) return "[unsupported MCP result part]";
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (part.type === "image" && typeof part.mimeType === "string") {
      return `[image: ${part.mimeType}]`;
    }
    if (part.type === "resource" && isRecord(part.resource)) {
      return typeof part.resource.text === "string"
        ? part.resource.text
        : `[binary resource: ${String(part.resource.uri ?? "unknown")}]`;
    }
    if (
      part.type === "resource_link" &&
      typeof part.name === "string" &&
      typeof part.uri === "string"
    ) {
      return `[resource: ${part.name} (${part.uri})]`;
    }
    return "[unsupported MCP result part]";
  });
  const structured = value.structuredContent === undefined ? "" : `\n${JSON.stringify(value.structuredContent)}`;
  return truncate(`${content.join("\n")}${structured}`.trim() || "(no output)", MAX_TOOL_OUTPUT_CHARS);
};

const promiseWithTimeout = async <T>(
  promise: Promise<T>,
  timeout: number,
  label: string,
  onLateValue?: (value: T) => void,
): Promise<T> => {
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} timed out.`));
    }, timeout);
  });
  promise.then(
    (value) => {
      if (timedOut) onLateValue?.(value);
    },
    () => undefined,
  );
  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const takeOptionValue = (args: readonly string[], index: number, option: string): string => {
  const value = args[index + 1];
  if (!value || value === "--") throw new Error(`${option} needs a value.`);
  return value;
};

export const parseMcpAddArguments = (args: readonly string[]): TiaMcpServer => {
  const name = args[0];
  if (!name) throw new Error("Usage: /mcp add <name> --url <url>");
  if (!isTiaMcpServerName(name)) {
    throw new Error("MCP server names may use letters, numbers, dots, underscores, and hyphens.");
  }

  const separator = args.indexOf("--");
  const hasRemoteTransport = args.includes("--url") || args.includes("--sse");
  if (hasRemoteTransport) {
    if (separator !== -1) {
      throw new Error("Remote MCP servers do not take a command after --.");
    }
    let transport: "http" | "sse" | undefined;
    let url: string | undefined;
    let bearerTokenEnvVar: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const option = args[index];
      if (option === "--url" || option === "--sse") {
        if (transport) throw new Error("Choose one remote transport: --url or --sse.");
        transport = option === "--url" ? "http" : "sse";
        url = readMcpUrl(takeOptionValue(args, index, option));
        index += 1;
        continue;
      }
      if (option === "--bearer-token-env") {
        if (bearerTokenEnvVar) throw new Error("--bearer-token-env can only be supplied once.");
        bearerTokenEnvVar = takeOptionValue(args, index, option);
        if (!isEnvironmentVariable(bearerTokenEnvVar)) {
          throw new Error("--bearer-token-env must be an environment-variable name.");
        }
        index += 1;
        continue;
      }
      throw new Error(`Unknown MCP add option: ${option}`);
    }
    if (!transport || !url) throw new Error("Specify either --url <url> or --sse <url>.");
    return {
      name,
      transport: { type: transport, url, ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}) },
    };
  }

  if (separator === -1) {
    throw new Error("Usage: /mcp add <name> [--env <NAME>]... -- <command> [args...]");
  }

  const envVars: string[] = [];
  let cwd: string | undefined;
  for (let index = 1; index < separator; index += 1) {
    const option = args[index];
    if (option === "--env") {
      const envVar = takeOptionValue(args, index, option);
      if (!isEnvironmentVariable(envVar)) {
        throw new Error("--env must be an environment-variable name.");
      }
      if (!envVars.includes(envVar)) envVars.push(envVar);
      index += 1;
      continue;
    }
    if (option === "--cwd") {
      if (cwd) throw new Error("--cwd can only be supplied once.");
      cwd = takeOptionValue(args, index, option);
      index += 1;
      continue;
    }
    throw new Error(`Unknown MCP add option: ${option}`);
  }

  const command = args[separator + 1];
  if (!command) throw new Error("Specify a command after --.");
  return {
    name,
    transport: {
      type: "stdio",
      command,
      args: args.slice(separator + 2),
      envVars,
      ...(cwd ? { cwd } : {}),
    },
  };
};

export class McpManager {
  private readonly configurationPath: string | undefined;
  private readonly connections = new Map<string, ConnectedMcpServer>();
  private disposed = false;

  constructor(options: McpManagerOptions = {}) {
    this.configurationPath = options.configurationPath;
  }

  private async configuredServers(): Promise<TiaMcpServer[]> {
    return (await loadTiaMcpConfiguration(this.configurationPath)).servers;
  }

  private summary(server: TiaMcpServer): McpServerSummary {
    return {
      name: server.name,
      transport: server.transport.type,
      endpoint: safeEndpoint(server),
      authStatus: authenticationStatus(server),
      connection: this.connections.has(server.name) ? "connected" : "disconnected",
    };
  }

  async listServers(): Promise<McpServerSummary[]> {
    return (await this.configuredServers())
      .map((server) => this.summary(server))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getServer(name: string): Promise<McpServerSummary | undefined> {
    const server = (await this.configuredServers()).find((candidate) => candidate.name === name);
    return server ? this.summary(server) : undefined;
  }

  private async resolveServer(name: string): Promise<TiaMcpServer> {
    const server = (await this.configuredServers()).find((candidate) => candidate.name === name);
    if (!server) throw new Error(`No TIA MCP server named "${name}" is configured.`);
    return server;
  }

  private createClient(server: TiaMcpServer): McpClientAttempt {
    if (server.transport.type === "stdio") {
      const env: Record<string, string> = {};
      const path = process.env.PATH ?? process.env.Path;
      if (path) env.PATH = path;
      if (process.platform === "win32") {
        for (const name of ["ComSpec", "PATHEXT", "SystemRoot"]) {
          const value = process.env[name];
          if (value) env[name] = value;
        }
      }
      for (const name of server.transport.envVars) {
        const value = process.env[name];
        if (value === undefined) {
          throw new Error(`"${server.name}" needs ${name} in TIA Code's environment.`);
        }
        env[name] = value;
      }
      const transport = new Experimental_StdioMCPTransport({
        command: server.transport.command,
        args: server.transport.args,
        env,
        cwd: server.transport.cwd,
        stderr: "ignore",
      });
      return {
        client: createMCPClient({ clientName: "tia-code", transport }),
        abort: () => transport.close(),
      };
    }

    const headers: Record<string, string> = {};
    if (server.transport.bearerTokenEnvVar) {
      const token = process.env[server.transport.bearerTokenEnvVar];
      if (!token) {
        throw new Error(
          `"${server.name}" needs ${server.transport.bearerTokenEnvVar} in TIA Code's environment.`,
        );
      }
      headers.Authorization = `Bearer ${token}`;
    }
    const authProvider = server.oauth
      ? createMcpOAuthProvider({
          serverName: server.name,
          redirectUrl: server.oauth.redirectUrl ?? OAUTH_REAUTH_REDIRECT_URL,
          configurationPath: this.configurationPath,
          onAuthorizationUrl: async () => {
            throw new Error(`Run /mcp login ${server.name} to complete OAuth sign-in.`);
          },
        })
      : undefined;
    const client = createMCPClient({
      clientName: "tia-code",
      transport: {
        type: server.transport.type,
        url: server.transport.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(authProvider ? { authProvider } : {}),
      },
    });
    return {
      client,
      abort: async () => {
        const connectedClient = await client.catch(() => undefined);
        await connectedClient?.close().catch(() => undefined);
      },
    };
  }

  async connect(name: string): Promise<{ server: McpServerSummary; tools: McpToolSummary[] }> {
    if (this.disposed) throw new Error("TIA's MCP manager has closed.");
    const existing = this.connections.get(name);
    if (existing) {
      const server = await this.resolveServer(name);
      return { server: this.summary(server), tools: existing.tools };
    }

    const server = await this.resolveServer(name);
    let client: MCPClient | undefined;
    let attempt: McpClientAttempt | undefined;
    try {
      attempt = this.createClient(server);
      client = await promiseWithTimeout(
        attempt.client,
        DEFAULT_STARTUP_TIMEOUT_MS,
        `Connecting to "${name}"`,
        (lateClient) => void lateClient.close(),
      );
      const response = await promiseWithTimeout(
        client.listTools({ options: { timeout: DEFAULT_TOOL_TIMEOUT_MS } }),
        DEFAULT_STARTUP_TIMEOUT_MS,
        `Discovering tools for "${name}"`,
      );
      const tools = response.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      if (this.disposed) {
        await client.close();
        throw new Error("TIA's MCP manager closed while connecting.");
      }
      this.connections.set(name, { client, tools });
      return { server: this.summary(server), tools };
    } catch (error) {
      await attempt?.abort().catch(() => undefined);
      await client?.close().catch(() => undefined);
      throw new Error(`Could not connect "${name}": ${messageFromUnknown(error)}`);
    }
  }

  async disconnect(name: string): Promise<boolean> {
    const connection = this.connections.get(name);
    if (!connection) return false;
    this.connections.delete(name);
    await connection.client.close().catch(() => undefined);
    return true;
  }

  private connectedCatalog(): Array<{ server: string; tools: McpToolSummary[] }> {
    return [...this.connections.entries()]
      .map(([server, connection]) => ({ server, tools: connection.tools }))
      .sort((left, right) => left.server.localeCompare(right.server));
  }

  private async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<CallToolResult> {
    const connection = this.connections.get(server);
    if (!connection) {
      throw new Error(`"${server}" is not connected. Ask the user to run /mcp connect ${server}.`);
    }
    if (!connection.tools.some((candidate) => candidate.name === tool)) {
      throw new Error(`"${tool}" is not available from connected MCP server "${server}".`);
    }
    return connection.client.callTool({
      name: tool,
      arguments: args,
      options: { signal, timeout: DEFAULT_TOOL_TIMEOUT_MS },
    });
  }

  createTools(): ToolDefinition[] {
    const manager = this;
    return [
      {
        name: "mcp_list_tools",
        label: "List Connected MCP Tools",
        description:
          "List MCP servers and tools that the user has connected to TIA with /mcp connect. Use this before calling mcp_call.",
        promptSnippet: "List tools from MCP servers the user explicitly connected to TIA.",
        promptGuidelines: [
          "Only use MCP servers listed by mcp_list_tools.",
          "Ask the user to run /mcp connect <server> before trying an unconnected server.",
        ],
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        } as ToolDefinition["parameters"],
        async execute() {
          const catalog = manager.connectedCatalog();
          const catalogText =
            catalog.length === 0
              ? "No MCP servers are connected to TIA. Ask the user to run /mcp connect <server>."
              : catalog
                  .map(({ server, tools }) => {
                    const definitions = tools.map((tool) => {
                      const schema =
                        tool.inputSchema === undefined
                          ? "unknown"
                          : truncate(JSON.stringify(tool.inputSchema), 6_000);
                      return [
                        `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`,
                        `  input schema: ${schema}`,
                      ].join("\n");
                    });
                    return `${server}:\n${definitions.join("\n") || "(no tools)"}`;
                  })
                  .join("\n\n");
          const text = truncate(catalogText, MAX_TOOL_OUTPUT_CHARS);
          return { content: [{ type: "text", text }], details: { catalog } };
        },
      },
      {
        name: "mcp_call",
        label: "Call Connected MCP Tool",
        description:
          "Call a tool on an MCP server the user explicitly connected to TIA. Discover exact server and tool names with mcp_list_tools first.",
        promptSnippet: "Call a tool on an explicitly connected MCP server.",
        promptGuidelines: [
          "Use mcp_list_tools before mcp_call when the exact tool name is not already known.",
          "Never invent an MCP server or tool name.",
        ],
        parameters: {
          type: "object",
          properties: {
            server: { type: "string", description: "Connected MCP server name" },
            tool: { type: "string", description: "Exact MCP tool name" },
            arguments: {
              type: "object",
              description: "Arguments accepted by the selected MCP tool",
              additionalProperties: true,
            },
          },
          required: ["server", "tool"],
          additionalProperties: false,
        } as ToolDefinition["parameters"],
        async execute(_toolCallId, params, signal) {
          const input = params as {
            server: string;
            tool: string;
            arguments?: Record<string, unknown>;
          };
          const result = await manager.callTool(input.server, input.tool, input.arguments ?? {}, signal);
          const text = serializeResult(result);
          if (isRecord(result) && result.isError === true) throw new Error(text);
          return {
            content: [{ type: "text", text }],
            details: { server: input.server, tool: input.tool },
          };
        },
      },
    ];
  }

  private listResult = async (): Promise<McpCommandResult> => {
    const servers = await this.listServers();
    if (servers.length === 0) {
      return { title: "MCP servers", lines: ["No MCP servers are configured for TIA Code."], tone: "info" };
    }
    return {
      title: "MCP servers",
      lines: servers.map((server) => {
        const location = server.endpoint ? ` · ${server.endpoint}` : "";
        return `${server.name} · ${server.transport}${location} · ${server.authStatus} · ${server.connection}`;
      }),
      tone: "info",
    };
  };

  async executeSlashCommand(parts: readonly string[]): Promise<McpCommandResult> {
    const [rawAction = "list", ...args] = parts;
    const action = rawAction.toLowerCase();

    if (action === "list") return this.listResult();

    if (action === "get") {
      const name = args[0];
      if (!name || args.length !== 1) {
        return { title: "MCP get", lines: ["Usage: /mcp get <name>"], tone: "error" };
      }
      const server = await this.getServer(name);
      if (!server) return { title: "MCP get", lines: [`No MCP server named "${name}".`], tone: "error" };
      return {
        title: `MCP · ${server.name}`,
        lines: [
          `transport: ${server.transport}`,
          ...(server.endpoint ? [`endpoint: ${server.endpoint}`] : []),
          `authentication: ${server.authStatus}`,
          `connection: ${server.connection}`,
          "Stored credentials and environment values are intentionally hidden.",
        ],
        tone: "info",
      };
    }

    if (action === "connect") {
      const name = args[0];
      if (!name || args.length !== 1) {
        return { title: "MCP connect", lines: ["Usage: /mcp connect <name>"], tone: "error" };
      }
      const { tools } = await this.connect(name);
      return {
        title: `Connected MCP · ${name}`,
        lines: [
          `${tools.length} tool${tools.length === 1 ? "" : "s"} available to TIA.`,
          ...tools.map((tool) => `${tool.name}${tool.description ? ` — ${tool.description}` : ""}`),
        ],
        tone: "success",
      };
    }

    if (action === "disconnect") {
      const name = args[0];
      if (!name || args.length !== 1) {
        return { title: "MCP disconnect", lines: ["Usage: /mcp disconnect <name>"], tone: "error" };
      }
      const disconnected = await this.disconnect(name);
      return {
        title: "MCP disconnect",
        lines: [disconnected ? `Disconnected "${name}" from TIA.` : `"${name}" was not connected to TIA.`],
        tone: "info",
      };
    }

    if (action === "add") {
      try {
        const server = parseMcpAddArguments(args);
        const existing = await this.getServer(server.name);
        await saveTiaMcpServer(server, this.configurationPath);
        await this.disconnect(server.name);
        return {
          title: "MCP add",
          lines: [
            `${existing ? "Updated" : "Added"} "${server.name}" in TIA Code's local MCP configuration.`,
            `Run /mcp connect ${server.name} to make its tools available in this session.`,
          ],
          tone: "success",
        };
      } catch (error) {
        return { title: "MCP add", lines: [messageFromUnknown(error)], tone: "error" };
      }
    }

    if (action === "remove") {
      const [name, confirmation] = args;
      if (!name || args.length > 2) {
        return { title: "MCP remove", lines: ["Usage: /mcp remove <name> --confirm"], tone: "error" };
      }
      if (confirmation !== "--confirm") {
        return {
          title: "MCP remove",
          lines: [`Run /mcp remove ${name} --confirm to remove this local MCP configuration.`],
          tone: "error",
        };
      }
      const removed = await removeTiaMcpServer(name, this.configurationPath);
      if (!removed) return { title: "MCP remove", lines: [`No MCP server named "${name}".`], tone: "error" };
      await this.disconnect(name);
      return {
        title: "MCP remove",
        lines: [`Removed "${name}" from TIA Code's local MCP configuration.`],
        tone: "success",
      };
    }

    if (action === "login") {
      const name = args[0];
      if (!name || args.length !== 1) {
        return { title: "MCP login", lines: ["Usage: /mcp login <name>"], tone: "error" };
      }
      const server = await this.resolveServer(name);
      await this.disconnect(name);
      await loginToMcpServer(server, this.configurationPath);
      return {
        title: "MCP login",
        lines: [
          `Signed in to "${name}".`,
          `Run /mcp connect ${name} to make its tools available in this session.`,
        ],
        tone: "success",
      };
    }

    if (action === "logout") {
      const name = args[0];
      if (!name || args.length !== 1) {
        return { title: "MCP logout", lines: ["Usage: /mcp logout <name>"], tone: "error" };
      }
      const updated = await updateTiaMcpServer(
        name,
        (server) => {
          const { oauth: _oauth, ...withoutOAuth } = server;
          return withoutOAuth;
        },
        this.configurationPath,
      );
      if (!updated) return { title: "MCP logout", lines: [`No MCP server named "${name}".`], tone: "error" };
      await this.disconnect(name);
      return {
        title: "MCP logout",
        lines: [`Cleared local OAuth credentials for "${name}".`],
        tone: "success",
      };
    }

    return {
      title: "MCP commands",
      lines: [
        "/mcp · /mcp list · /mcp get <name>",
        "/mcp connect <name> · /mcp disconnect <name>",
        "/mcp add <name> --url <url> [--bearer-token-env <NAME>]",
        "/mcp add <name> --sse <url> [--bearer-token-env <NAME>]",
        "/mcp add <name> [--env <NAME>]... [--cwd <path>] -- <command> [args...]",
        "/mcp remove <name> --confirm · /mcp login <name> · /mcp logout <name>",
      ],
      tone: "info",
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map((connection) => connection.client.close().catch(() => undefined)));
  }
}
