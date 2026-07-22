import { Box, Text } from "ink";
import {
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ErrorPrimitive,
  LoadingPrimitive,
  LiveChecklist,
} from "@assistant-ui/react-ink";
import { MarkdownText } from "@assistant-ui/react-ink-markdown";

const formatToolResult = (result: unknown): string => {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
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
        renderText={({ part }) => <MarkdownText text={part.text} />}
        renderReasoning={({ part }) => (
          <Text dimColor italic>
            {part.text}
          </Text>
        )}
        renderToolCall={({ part }) => (
          <Box flexDirection="column" marginTop={1}>
            <Text color={part.isError ? "red" : "cyan"}>
              {part.isError ? "×" : "→"} {part.toolName}
              {part.result === undefined ? "  running" : part.isError ? "  failed" : "  done"}
            </Text>
            {part.result !== undefined ? (
              <Text dimColor wrap="truncate">
                {formatToolResult(part.result)}
              </Text>
            ) : null}
          </Box>
        )}
      />
      <LiveChecklist title="Plan" showProgress marginTop={1} />
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

export const Thread = () => {
  return (
    <ThreadPrimitive.Root>
      <ThreadPrimitive.Empty>
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            TIA Code is ready in this project with <Text color="yellow">Pi</Text> as
            its coding harness.
          </Text>
          <Text dimColor>
            Pi reads this workspace and can use its coding tools through your configured model.
          </Text>
          <Text dimColor>{'  try: "inspect this project and explain its structure"'}</Text>
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
