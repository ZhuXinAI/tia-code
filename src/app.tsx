import { useEffect, useMemo } from "react";
import { Box, Text } from "ink";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  StatusBarPrimitive,
} from "@assistant-ui/react-ink";
import { Thread } from "./components/thread.js";
import { createPiAdapter, MODEL_NAME } from "./pi-adapter.js";

const StatusBar = () => (
  <StatusBarPrimitive.Root>
    <Text dimColor>
      model: <StatusBarPrimitive.ModelName name={MODEL_NAME} /> ·{" "}
      <StatusBarPrimitive.MessageCount /> · <StatusBarPrimitive.Status />
    </Text>
  </StatusBarPrimitive.Root>
);

export const App = () => {
  const adapter = useMemo(() => createPiAdapter(), []);
  useEffect(
    () => () => {
      void adapter.dispose();
    },
    [adapter],
  );
  const runtime = useLocalRuntime(adapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Box flexDirection="column" padding={1}>
        <Box>
          <Text bold color="cyan">
            TIA Code
          </Text>
          <Text dimColor>{"  "}{process.cwd()}</Text>
        </Box>
        <StatusBar />
        <Box marginTop={1}>
          <Thread />
        </Box>
      </Box>
    </AssistantRuntimeProvider>
  );
};
