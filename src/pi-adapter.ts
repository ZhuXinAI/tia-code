import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ChatModelRunResult,
  ThreadAssistantMessagePart,
  ThreadMessageLike,
} from "@assistant-ui/react-ink";
import {
  createPiModelRuntime,
  ensurePiSessionDirectory,
  type PiConfiguration,
} from "./pi-configuration.js";
import type { PiSessionExitSummary } from "./session-exit.js";

type PiChatModelAdapter = ChatModelAdapter & {
  initialize(): Promise<readonly ThreadMessageLike[]>;
  dispose(): Promise<PiSessionExitSummary | undefined>;
};

type PiAdapterOptions = {
  resumeSessionId?: string;
};

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private waiter:
    | {
        resolve: (result: IteratorResult<T>) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  private done = false;
  private failure: unknown;

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.resolve({ done: true, value: undefined as never });
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.failure = error;
    this.done = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.failure) return Promise.reject(this.failure);
    if (this.done) return Promise.resolve({ done: true, value: undefined as never });
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}

type StreamState = {
  parts: ThreadAssistantMessagePart[];
  /** Content indexes are scoped to one streamed Pi assistant message. */
  contentPartIndexes: Map<number, number>;
  toolPartIndexes: Map<string, number>;
  error?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringFromUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const toToolArgs = (value: unknown): Record<string, never> =>
  (isRecord(value) ? value : { value: value ?? null }) as Record<string, never>;

const updateFor = (state: StreamState): ChatModelRunResult => ({
  content: [...state.parts],
});

const formatDuration = (durationMs: number): string => {
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
};

const appendDuration = (state: StreamState, startedAt: number): void => {
  state.parts.push({
    type: "text",
    text: `Worked for ${formatDuration(Date.now() - startedAt)}`,
  });
};

const appendDelta = (
  state: StreamState,
  contentIndex: number,
  type: "text" | "reasoning",
  delta: string,
): boolean => {
  const partIndex = state.contentPartIndexes.get(contentIndex);
  if (partIndex === undefined) {
    state.contentPartIndexes.set(contentIndex, state.parts.length);
    state.parts.push({ type, text: delta });
    return true;
  }

  const part = state.parts[partIndex];
  if (!part || part.type !== type) return false;
  state.parts[partIndex] = { ...part, text: `${part.text}${delta}` };
  return true;
};

const applyPiEvent = (state: StreamState, event: AgentSessionEvent): boolean => {
  switch (event.type) {
    case "message_start": {
      if (event.message.role === "assistant") state.contentPartIndexes.clear();
      return false;
    }
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        return appendDelta(state, update.contentIndex, "text", update.delta);
      }
      if (update.type === "thinking_delta") {
        return appendDelta(state, update.contentIndex, "reasoning", update.delta);
      }
      if (update.type === "error") {
        state.error = update;
      }
      return false;
    }
    case "message_end": {
      if (event.message.role === "assistant" && event.message.stopReason === "error") {
        state.error = event.message.errorMessage ?? "Pi stopped with an error";
      }
      return false;
    }
    case "tool_execution_start": {
      const args = toToolArgs(event.args);
      state.toolPartIndexes.set(event.toolCallId, state.parts.length);
      state.parts.push({
        type: "tool-call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args,
        argsText: stringFromUnknown(args),
      });
      return true;
    }
    case "tool_execution_update":
    case "tool_execution_end": {
      const partIndex = state.toolPartIndexes.get(event.toolCallId);
      const part = partIndex === undefined ? undefined : state.parts[partIndex];
      if (
        partIndex === undefined ||
        !part ||
        part.type !== "tool-call" ||
        part.toolName !== event.toolName
      ) {
        return false;
      }

      if (event.type === "tool_execution_update") {
        state.parts[partIndex] = { ...part, result: event.partialResult };
      } else {
        state.parts[partIndex] = {
          ...part,
          result: event.result,
          isError: event.isError,
        };
      }
      return true;
    }
    default:
      return false;
  }
};

const lastUserText = (messages: ChatModelRunOptions["messages"]): string => {
  const message = [...messages].reverse().find((candidate) => candidate.role === "user");
  if (!message) return "";
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
      part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
};

type TranscriptToolCall = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: Record<string, never>;
  argsText: string;
  result?: unknown;
  isError?: boolean;
};

type TranscriptPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | TranscriptToolCall;

const transcriptStatus = (stopReason: string): NonNullable<ThreadMessageLike["status"]> => {
  if (stopReason === "error") return { type: "incomplete", reason: "error" };
  if (stopReason === "aborted") return { type: "incomplete", reason: "cancelled" };
  return { type: "complete", reason: stopReason === "stop" ? "stop" : "unknown" };
};

const piContentText = (content: readonly unknown[]): string =>
  content
    .map((part) => {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (isRecord(part) && part.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");

const transcriptFrom = (session: AgentSession): ThreadMessageLike[] => {
  const messages: ThreadMessageLike[] = [];
  const toolCalls = new Map<string, TranscriptToolCall>();

  for (const [messageIndex, message] of session.state.messages.entries()) {
    if (message.role === "user") {
      messages.push({
        id: `pi-user-${message.timestamp}-${messageIndex}`,
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : piContentText(message.content),
        createdAt: new Date(message.timestamp),
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: TranscriptPart[] = [];
      for (const part of message.content) {
        if (part.type === "text" && part.text) {
          content.push({ type: "text", text: part.text });
          continue;
        }
        if (part.type === "thinking" && part.thinking) {
          content.push({ type: "reasoning", text: part.thinking });
          continue;
        }
        if (part.type === "toolCall") {
          const toolCall: TranscriptToolCall = {
            type: "tool-call",
            toolCallId: part.id,
            toolName: part.name,
            args: toToolArgs(part.arguments),
            argsText: stringFromUnknown(part.arguments),
          };
          toolCalls.set(part.id, toolCall);
          content.push(toolCall);
        }
      }
      messages.push({
        id: `pi-assistant-${message.timestamp}-${messageIndex}`,
        role: "assistant",
        content,
        createdAt: new Date(message.timestamp),
        status: transcriptStatus(message.stopReason),
      });
      continue;
    }

    if (message.role === "toolResult") {
      const toolCall = toolCalls.get(message.toolCallId);
      if (toolCall) {
        toolCall.result = message.details ?? piContentText(message.content);
        toolCall.isError = message.isError;
      }
    }
  }

  return messages;
};

const createSessionManager = async (
  cwd: string,
  resumeSessionId: string | undefined,
): Promise<SessionManager> => {
  const sessionDirectory = await ensurePiSessionDirectory();
  if (!resumeSessionId) return SessionManager.create(cwd, sessionDirectory);

  const session = (await SessionManager.list(cwd, sessionDirectory)).find(
    (candidate) => candidate.id === resumeSessionId,
  );
  if (!session) {
    throw new Error(`No saved Pi session with ID "${resumeSessionId}" exists for this directory.`);
  }
  return SessionManager.open(session.path, sessionDirectory, cwd);
};

const reasoningTokensFor = (session: AgentSession): number =>
  session.sessionManager.getEntries().reduce((total, entry) => {
    if (entry.type !== "message" || entry.message.role !== "assistant") return total;
    return total + (entry.message.usage.reasoning ?? 0);
  }, 0);

/**
 * Bridges one in-process Pi SDK session to assistant-ui's local runtime.
 * Pi owns model selection, its workspace-aware resource loader, tools, and
 * conversation state; Ink only renders the translated event stream. Provider
 * credentials are injected into the ModelRuntime for this process only.
 */
export const createPiAdapter = (
  configuration: PiConfiguration,
  cwd = process.cwd(),
  options: PiAdapterOptions = {},
): PiChatModelAdapter => {
  let liveSession: AgentSession | undefined;
  let opening: Promise<AgentSession> | undefined;
  let disposed = false;
  let closing: Promise<PiSessionExitSummary | undefined> | undefined;

  const ensureSession = async (): Promise<AgentSession> => {
    if (disposed) throw new Error("Pi session has been closed");
    if (liveSession) return liveSession;
    if (!opening) {
      opening = (async () => {
        const { agentDir, modelRuntime, model } = await createPiModelRuntime(configuration);
        const settingsManager = SettingsManager.inMemory();
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
        });
        await resourceLoader.reload();
        const sessionManager = await createSessionManager(cwd, options.resumeSessionId);
        const { session } = await createAgentSession({
          cwd,
          agentDir,
          modelRuntime,
          model,
          resourceLoader,
          settingsManager,
          sessionManager,
        });
        liveSession = session;
        return session;
      })().finally(() => {
        opening = undefined;
      });
    }
    return opening;
  };

  const initialize = async (): Promise<readonly ThreadMessageLike[]> => {
    const session = await ensureSession();
    return transcriptFrom(session);
  };

  const dispose = (): Promise<PiSessionExitSummary | undefined> => {
    if (closing) return closing;
    disposed = true;

    closing = (async () => {
      const session = liveSession ?? (opening ? await opening.catch(() => undefined) : undefined);
      liveSession = undefined;
      if (!session) return undefined;

      try {
        await session.abort().catch(() => undefined);
        const stats = session.getSessionStats();
        const sessionFile = stats.sessionFile;
        const isResumable = Boolean(
          stats.assistantMessages > 0 && sessionFile && existsSync(sessionFile),
        );
        if (isResumable && sessionFile) {
          await chmod(sessionFile, 0o600).catch(() => undefined);
        }
        const reasoningTokens = reasoningTokensFor(session);
        return {
          stats,
          reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
          resumeSessionId: isResumable ? stats.sessionId : undefined,
        };
      } finally {
        session.dispose();
      }
    })();

    return closing;
  };

  return {
    initialize,
    dispose,
    async *run(options) {
      const prompt = lastUserText(options.messages);
      if (!prompt) throw new Error("Message is empty");

      const startedAt = Date.now();
      const session = await ensureSession();
      const queue = new AsyncQueue<ChatModelRunResult>();
      const state: StreamState = {
        parts: [],
        contentPartIndexes: new Map(),
        toolPartIndexes: new Map(),
      };
      let complete = false;

      const unsubscribe = session.subscribe((event) => {
        if (applyPiEvent(state, event)) queue.push(updateFor(state));
      });
      const abort = () => {
        void session.abort().catch((error: unknown) => queue.fail(error));
      };
      options.abortSignal.addEventListener("abort", abort, { once: true });

      void session
        .prompt(prompt, session.isStreaming ? { streamingBehavior: "steer" } : undefined)
        .then(
          () => {
            appendDuration(state, startedAt);
            queue.push(
              state.error
                ? {
                    ...updateFor(state),
                    status: {
                      type: "incomplete",
                      reason: "error",
                      error: stringFromUnknown(state.error),
                    },
                  }
                : updateFor(state),
            );
            queue.close();
          },
          (error: unknown) => {
            appendDuration(state, startedAt);
            queue.push({
              ...updateFor(state),
              status: {
                type: "incomplete",
                reason: "error",
                error: stringFromUnknown(error),
              },
            });
            queue.close();
          },
        );

      try {
        for (;;) {
          const next = await queue.next();
          if (next.done) break;
          yield next.value;
        }
        complete = true;
      } finally {
        unsubscribe();
        options.abortSignal.removeEventListener("abort", abort);
        if (!complete && session.isStreaming) void session.abort();
      }
    },
  };
};
