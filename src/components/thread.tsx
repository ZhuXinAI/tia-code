import { homedir } from "node:os";
import { Box, Text } from "ink";
import {
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ErrorPrimitive,
  LoadingPrimitive,
} from "@assistant-ui/react-ink";
import { MarkdownText } from "@assistant-ui/react-ink-markdown";

type ThreadProps = {
  modelName: string;
  directory: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const compactText = (value: string, maxLength = 112): string => {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
};

const toDisplayText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toDisplayText).filter(Boolean).join("\n");
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if ("content" in value) return toDisplayText(value.content);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const toolResultPreview = (result: unknown): { text: string; extraLines: number } => {
  const lines = toDisplayText(result)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { text: "(no output)", extraLines: 0 };
  return { text: compactText(lines[0]!), extraLines: lines.length - 1 };
};

const stringArg = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
};

const toolSummary = (toolName: string, rawArgs: unknown): string => {
  const args = isRecord(rawArgs) ? rawArgs : {};
  const path = stringArg(args, "path");

  if (toolName === "bash") return `Run ${compactText(stringArg(args, "command") ?? "shell command")}`;
  if (toolName === "read") return `Read ${path ?? "file"}`;
  if (toolName === "write") return `Write ${path ?? "file"}`;
  if (toolName === "edit") return `Edit ${path ?? "file"}`;
  if (toolName === "ls") return `List ${path ?? "directory"}`;
  if (toolName === "grep") {
    return `Search ${path ?? "project"} for ${compactText(stringArg(args, "pattern") ?? "text")}`;
  }
  if (toolName === "find") return `Find ${compactText(stringArg(args, "query") ?? path ?? "files")}`;

  const details = Object.entries(args)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");
  return details ? `${toolName} ${compactText(details)}` : toolName;
};

const ToolCall = ({
  part,
}: {
  part: { toolName: string; args: unknown; result?: unknown; isError?: boolean };
}) => {
  const state = part.result === undefined ? "running" : part.isError ? "failed" : "done";
  const color = part.isError ? "red" : part.result === undefined ? "yellow" : "cyan";
  const preview = part.result === undefined ? undefined : toolResultPreview(part.result);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={color}>• </Text>
        <Text bold color={color}>
          {toolSummary(part.toolName, part.args)}
        </Text>
        <Text dimColor> · {state}</Text>
      </Text>
      {preview ? (
        <>
          <Text dimColor wrap="truncate">
            {"  └ "}{preview.text}
          </Text>
          {preview.extraLines > 0 ? (
            <Text dimColor>
              {"    … "}{preview.extraLines} more line{preview.extraLines === 1 ? "" : "s"}
            </Text>
          ) : null}
        </>
      ) : null}
    </Box>
  );
};

const displayDirectory = (directory: string): string => {
  const home = homedir();
  return directory === home ? "~" : directory.startsWith(`${home}/`) ? `~${directory.slice(home.length)}` : directory;
};

const UserMessage = () => (
  <MessagePrimitive.Root>
    <Box marginBottom={1}>
      <Text bold color="green">
        You:{" "}
      </Text>
      <MessagePrimitive.Content
        renderText={({ part }) => <Text wrap="wrap">{part.text}</Text>}
      />
    </Box>
  </MessagePrimitive.Root>
);

const AssistantMessage = () => (
  <MessagePrimitive.Root>
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="blue">
        Pi:
      </Text>
      <MessagePrimitive.Content
        renderText={({ part }) =>
          part.text.startsWith("Worked for ") ? (
            <Box marginTop={1}>
              <Text dimColor>— {part.text} —</Text>
            </Box>
          ) : (
            <MarkdownText text={part.text} />
          )
        }
        renderReasoning={({ part }) => (
          <Text dimColor italic>
            {part.text}
          </Text>
        )}
        renderToolCall={({ part }) => <ToolCall part={part} />}
      />
      <ErrorPrimitive.Root>
        <ErrorPrimitive.Message />
      </ErrorPrimitive.Root>
    </Box>
  </MessagePrimitive.Root>
);

const Loading = () => (
  <LoadingPrimitive.Root marginBottom={1}>
    <LoadingPrimitive.Spinner />
    <Text> </Text>
    <LoadingPrimitive.Text>Working</LoadingPrimitive.Text>
    <Text> </Text>
    <LoadingPrimitive.ElapsedTime />
  </LoadingPrimitive.Root>
);

export const Thread = ({ modelName, directory }: ThreadProps) => {
  return (
    <ThreadPrimitive.Root>
      <ThreadPrimitive.Empty>
        <Box flexDirection="column" marginBottom={1}>
          <Box
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
            flexDirection="column"
            width={62}
          >
            <Text>
              <Text dimColor>{">_ "}</Text>
              <Text bold color="cyan">
                TIA Code
              </Text>
              <Text dimColor> (Pi harness)</Text>
            </Text>
            <Box marginTop={1} flexDirection="column">
              <Text>
                <Text dimColor>model:     </Text>
                <Text>{modelName}</Text>
                <Text color="cyan">  Ctrl+O to change</Text>
              </Text>
              <Text>
                <Text dimColor>directory: </Text>
                <Text>{displayDirectory(directory)}</Text>
              </Text>
              <Text>
                <Text dimColor>tools:     </Text>
                <Text color="yellow">Pi coding tools</Text>
              </Text>
            </Box>
          </Box>
          <Box marginTop={1} marginLeft={1}>
            <Text>
              <Text bold>Tip: </Text>
              Start with an outcome, or ask Pi to inspect the current project.
            </Text>
          </Box>
        </Box>
      </ThreadPrimitive.Empty>

      <ThreadPrimitive.Messages>
        {({ message }) =>
          message.role === "user" ? <UserMessage /> : <AssistantMessage />
        }
      </ThreadPrimitive.Messages>

      <Loading />

      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="gray">{"> "}</Text>
        <ComposerPrimitive.Input
          submitOnEnter
          multiLine
          placeholder="Ask Pi to inspect or change this project... (Enter to send)"
          autoFocus
        />
      </Box>
    </ThreadPrimitive.Root>
  );
};
