import type { McpCommandResult } from "../mcp-manager.js";

const COMMAND_RESULT_KEY = "tiaCodeCommandResult";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const commandResultMetadata = (result: McpCommandResult) => ({
  custom: { [COMMAND_RESULT_KEY]: result },
});

export const commandResultFromMessage = (message: unknown): McpCommandResult | undefined => {
  if (!isRecord(message) || !isRecord(message.metadata) || !isRecord(message.metadata.custom)) {
    return undefined;
  }

  const result = message.metadata.custom[COMMAND_RESULT_KEY];
  if (!isRecord(result) || typeof result.title !== "string" || !Array.isArray(result.lines)) {
    return undefined;
  }
  if (!result.lines.every((line) => typeof line === "string")) return undefined;
  if (result.tone !== undefined && result.tone !== "success" && result.tone !== "error" && result.tone !== "info") {
    return undefined;
  }

  return {
    title: result.title,
    lines: result.lines,
    ...(result.tone ? { tone: result.tone } : {}),
  };
};
