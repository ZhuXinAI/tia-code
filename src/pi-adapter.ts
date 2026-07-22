import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ChatModelRunResult,
  ThreadAssistantMessagePart,
} from "@assistant-ui/react-ink";

export const MODEL_NAME = "Pi Coding Agent";

type PiChatModelAdapter = ChatModelAdapter & {
  dispose(): Promise<void>;
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

/**
 * Bridges one in-process Pi SDK session to assistant-ui's local runtime.
 * Pi owns model selection, its workspace-aware resource loader, tools, and
 * conversation state; Ink only renders the translated event stream.
 */
export const createPiAdapter = (cwd = process.cwd()): PiChatModelAdapter => {
  let liveSession: AgentSession | undefined;
  let opening: Promise<AgentSession> | undefined;
  let disposed = false;

  const ensureSession = async (): Promise<AgentSession> => {
    if (disposed) throw new Error("Pi session has been closed");
    if (liveSession) return liveSession;
    if (!opening) {
      opening = (async () => {
        const modelRuntime = await ModelRuntime.create();
        const { session } = await createAgentSession({
          cwd,
          modelRuntime,
          sessionManager: SessionManager.inMemory(cwd),
        });
        liveSession = session;
        return session;
      })().finally(() => {
        opening = undefined;
      });
    }
    return opening;
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;

    const session = liveSession ?? (opening ? await opening.catch(() => undefined) : undefined);
    liveSession = undefined;
    if (!session) return;

    await session.abort().catch(() => undefined);
    session.dispose();
  };

  return {
    dispose,
    async *run(options) {
      const prompt = lastUserText(options.messages);
      if (!prompt) throw new Error("Message is empty");

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
            if (state.error) {
              queue.push({
                ...updateFor(state),
                status: {
                  type: "incomplete",
                  reason: "error",
                  error: stringFromUnknown(state.error),
                },
              });
            }
            queue.close();
          },
          (error: unknown) => queue.fail(error),
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
