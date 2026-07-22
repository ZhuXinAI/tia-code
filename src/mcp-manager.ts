import { spawn, type ChildProcess } from "node:child_process";
import { createMCPClient, type CallToolResult, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type UnknownRecord = Record<string, unknown>;

type StdioTransport = {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  envVars: string[];
  cwd?: string;
};

type HttpTransport = {
  type: "streamable_http";
  url: string;
  bearerTokenEnvVar?: string;
  headers: Record<string, string>;
  envHeaders: Record<string, string>;
};

type UnsupportedTransport = {
  type: "unsupported";
};

type CodexMcpServer = {
  name: string;
  enabled: boolean;
  authStatus: string;
  transport: StdioTransport | HttpTransport | UnsupportedTransport;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
};

export type McpServerSummary = {
  name: string;
  enabled: boolean;
  transport: "stdio" | "streamable_http" | "unsupported";
  endpoint?: string;
  authStatus: string;
  connection: "connected" | "disconnected" | "unavailable";
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

type ConnectedMcpServer = {
  client: MCPClient;
  tools: McpToolSummary[];
};

type McpClientAttempt = {
  client: Promise<MCPClient>;
  abort: () => Promise<void>;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 12_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const MAX_TOOL_OUTPUT_CHARS = 48_000;

const isRecord = (value: unknown): value is UnknownRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const stringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

const timeoutMs = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.round(value * 1_000), 120_000)
    : fallback;

const parseTransport = (
  value: unknown,
): StdioTransport | HttpTransport | UnsupportedTransport => {
  if (!isRecord(value)) return { type: "unsupported" };

  if (value.type === "stdio") {
    const command = stringValue(value.command);
    if (!command) return { type: "unsupported" };
    return {
      type: "stdio",
      command,
      args: stringList(value.args),
      env: stringRecord(value.env),
      envVars: stringList(value.env_vars),
      cwd: stringValue(value.cwd),
    };
  }

  if (value.type === "streamable_http") {
    const url = stringValue(value.url);
    if (!url) return { type: "unsupported" };
    return {
      type: "streamable_http",
      url,
      bearerTokenEnvVar: stringValue(value.bearer_token_env_var),
      headers: stringRecord(value.http_headers),
      envHeaders: stringRecord(value.env_http_headers),
    };
  }

  return { type: "unsupported" };
};

const parseMcpServers = (value: unknown): CodexMcpServer[] => {
  if (!Array.isArray(value)) throw new Error("Codex returned an invalid MCP server list.");

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = stringValue(entry.name);
    if (!name) return [];
    return [
      {
        name,
        enabled: entry.enabled === true,
        authStatus: stringValue(entry.auth_status) ?? "unknown",
        transport: parseTransport(entry.transport),
        startupTimeoutMs: timeoutMs(entry.startup_timeout_sec, DEFAULT_STARTUP_TIMEOUT_MS),
        toolTimeoutMs: timeoutMs(entry.tool_timeout_sec, DEFAULT_TOOL_TIMEOUT_MS),
      },
    ];
  });
};

const safeEndpoint = (transport: CodexMcpServer["transport"]): string | undefined => {
  if (transport.type !== "streamable_http") return undefined;
  try {
    const url = new URL(transport.url);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "configured URL";
  }
};

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "The operation failed.";

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;

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

class CodexMcpRunner {
  private readonly active = new Set<ChildProcess>();
  private disposed = false;

  async run(args: readonly string[]): Promise<string> {
    if (this.disposed) throw new Error("TIA's MCP command runner has closed.");

    return new Promise<string>((resolve, reject) => {
      const child = spawn("codex", ["mcp", ...args], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.active.add(child);

      let output = "";
      const collect = (chunk: Buffer | string) => {
        if (output.length >= MAX_COMMAND_OUTPUT_BYTES) return;
        output += chunk.toString().slice(0, MAX_COMMAND_OUTPUT_BYTES - output.length);
      };
      child.stdout?.on("data", collect);
      // Drain stderr without exposing possibly sensitive CLI echoes in the TUI.
      child.stderr?.on("data", () => undefined);

      const finish = () => this.active.delete(child);
      child.once("error", () => {
        finish();
        reject(new Error("TIA could not start the Codex MCP command."));
      });
      child.once("close", (code) => {
        finish();
        if (code === 0) {
          resolve(output);
          return;
        }
        reject(new Error("The Codex MCP command did not complete successfully."));
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.active) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    this.active.clear();
  }
}

const isOAuthOnly = (server: CodexMcpServer): boolean =>
  server.authStatus === "o_auth" || server.authStatus === "not_logged_in";

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

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

/**
 * Maps Codex's configured transports to AI SDK MCP clients. Connection is
 * explicit: a configured server is not made available to the coding agent
 * until the user chooses `/mcp connect <name>`.
 */
export class McpManager {
  private readonly runner = new CodexMcpRunner();
  private readonly connections = new Map<string, ConnectedMcpServer>();
  private disposed = false;

  private async configuredServers(): Promise<CodexMcpServer[]> {
    const output = await this.runner.run(["list", "--json"]);
    try {
      return parseMcpServers(JSON.parse(output));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Codex returned unreadable MCP configuration.");
      }
      throw error;
    }
  }

  private summary(server: CodexMcpServer): McpServerSummary {
    return {
      name: server.name,
      enabled: server.enabled,
      transport: server.transport.type,
      endpoint: safeEndpoint(server.transport),
      authStatus: server.authStatus,
      connection: this.connections.has(server.name)
        ? "connected"
        : isOAuthOnly(server)
          ? "unavailable"
          : "disconnected",
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

  private async resolveServer(name: string): Promise<CodexMcpServer> {
    const server = (await this.configuredServers()).find((candidate) => candidate.name === name);
    if (!server) throw new Error(`No Codex MCP server named "${name}" is configured.`);
    return server;
  }

  private createClient(server: CodexMcpServer): McpClientAttempt {
    if (server.transport.type === "unsupported") {
      throw new Error(`TIA does not support the configured transport for "${server.name}".`);
    }
    if (isOAuthOnly(server)) {
      throw new Error(
        `"${server.name}" uses Codex OAuth. TIA cannot reuse Codex's OAuth credential store; configure a bearer token or another supported transport for this app.`,
      );
    }

    if (server.transport.type === "stdio") {
      const env = { ...server.transport.env };
      for (const name of server.transport.envVars) {
        const value = process.env[name];
        if (value !== undefined && env[name] === undefined) env[name] = value;
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

    const headers = { ...server.transport.headers };
    for (const [header, envName] of Object.entries(server.transport.envHeaders)) {
      const value = process.env[envName];
      if (value !== undefined) headers[header] = value;
    }
    if (server.transport.bearerTokenEnvVar) {
      const token = process.env[server.transport.bearerTokenEnvVar];
      if (!token) {
        throw new Error(
          `"${server.name}" needs ${server.transport.bearerTokenEnvVar} in TIA Code's environment.`,
        );
      }
      if (!hasHeader(headers, "authorization")) headers.Authorization = `Bearer ${token}`;
    }

    const client = createMCPClient({
      clientName: "tia-code",
      transport: {
        type: "http",
        url: server.transport.url,
        headers,
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
    if (!server.enabled) throw new Error(`"${name}" is disabled in Codex. Enable it before connecting.`);

    let client: MCPClient | undefined;
    let attempt: McpClientAttempt | undefined;
    try {
      attempt = this.createClient(server);
      client = await promiseWithTimeout(
        attempt.client,
        server.startupTimeoutMs,
        `Connecting to "${name}"`,
        (lateClient) => void lateClient.close(),
      );
      const response = await promiseWithTimeout(
        client.listTools({ options: { timeout: server.toolTimeoutMs } }),
        server.startupTimeoutMs,
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
    const config = await this.resolveServer(server);
    return connection.client.callTool({
      name: tool,
      arguments: args,
      options: { signal, timeout: config.toolTimeoutMs },
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
            server: { type: "string", description: "Connected Codex MCP server name" },
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
      return { title: "MCP servers", lines: ["No Codex MCP servers are configured."], tone: "info" };
    }
    return {
      title: "Codex MCP servers",
      lines: servers.map((server) => {
        const location = server.endpoint ? ` · ${server.endpoint}` : "";
        return `${server.name} · ${server.enabled ? "enabled" : "disabled"} · ${server.transport}${location} · ${server.connection}`;
      }),
      tone: "info",
    };
  };

  async executeSlashCommand(parts: readonly string[]): Promise<McpCommandResult> {
    const [action = "list", ...args] = parts;

    if (action === "list") return this.listResult();

    if (action === "get") {
      const name = args[0];
      if (!name || args.length !== 1) {
        return { title: "MCP get", lines: ["Usage: /mcp get <name>"], tone: "error" };
      }
      // Keep this mapped to Codex's get command while only rendering a redacted summary.
      await this.runner.run(["get", name, "--json"]);
      const server = await this.getServer(name);
      if (!server) return { title: "MCP get", lines: [`No MCP server named "${name}".`], tone: "error" };
      return {
        title: `MCP · ${server.name}`,
        lines: [
          `status: ${server.enabled ? "enabled" : "disabled"}`,
          `transport: ${server.transport}`,
          ...(server.endpoint ? [`endpoint: ${server.endpoint}`] : []),
          `authentication: ${server.authStatus}`,
          `connection: ${server.connection}`,
          "Sensitive environment variables and HTTP headers are intentionally hidden.",
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

    if (action === "remove") {
      const [name, confirmation] = args;
      if (!name || args.length > 2) {
        return { title: "MCP remove", lines: ["Usage: /mcp remove <name> --confirm"], tone: "error" };
      }
      if (confirmation !== "--confirm") {
        return {
          title: "MCP remove",
          lines: [`Removing "${name}" changes the shared Codex configuration. Run /mcp remove ${name} --confirm.`],
          tone: "error",
        };
      }
      await this.runner.run(["remove", name]);
      await this.disconnect(name);
      return { title: "MCP remove", lines: [`Removed "${name}" from Codex MCP.`], tone: "success" };
    }

    if (action === "add") {
      if (args.length === 0) {
        return {
          title: "MCP add",
          lines: [
            "Usage: /mcp add <name> --url <url>",
            "   or: /mcp add <name> -- <command> [args...]",
          ],
          tone: "error",
        };
      }
      await this.runner.run(["add", ...args]);
      return { title: "MCP add", lines: ["Added the MCP server to Codex."], tone: "success" };
    }

    if (action === "login" || action === "logout") {
      const name = args[0];
      if (!name) {
        return { title: `MCP ${action}`, lines: [`Usage: /mcp ${action} <name>`], tone: "error" };
      }
      await this.runner.run([action, ...args]);
      return {
        title: `MCP ${action}`,
        lines: [`Codex MCP ${action} completed for "${name}".`],
        tone: "success",
      };
    }

    return {
      title: "MCP commands",
      lines: [
        "/mcp · /mcp list · /mcp get <name>",
        "/mcp connect <name> · /mcp disconnect <name>",
        "/mcp add <name> --url <url> · /mcp add <name> -- <command>",
        "/mcp remove <name> --confirm · /mcp login <name> · /mcp logout <name>",
      ],
      tone: "info",
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.runner.dispose();
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map((connection) => connection.client.close().catch(() => undefined)));
  }
}
