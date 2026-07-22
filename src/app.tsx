import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useAuiState,
  StatusBarPrimitive,
} from "@assistant-ui/react-ink";
import { Thread } from "./components/thread.js";
import { PiSetup } from "./components/pi-setup.js";
import { createPiAdapter } from "./pi-adapter.js";
import {
  getProviderOption,
  loadPiConfiguration,
  type PiConfiguration,
} from "./pi-configuration.js";

const StatusBar = ({ modelName }: { modelName: string }) => (
  <StatusBarPrimitive.Root>
    <Text dimColor>
      model: <StatusBarPrimitive.ModelName name={modelName} /> ·{" "}
      <StatusBarPrimitive.MessageCount /> · <StatusBarPrimitive.Status />
    </Text>
  </StatusBarPrimitive.Root>
);

const ConfigurationLoading = () => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="cyan">
      TIA Code
    </Text>
    <Text dimColor>Loading your Pi configuration…</Text>
  </Box>
);

const Conversation = ({ modelName }: { modelName: string }) => {
  const hasMessages = useAuiState((state) => state.thread.messages.length > 0);

  return (
    <Box flexDirection="column" padding={1}>
      {hasMessages ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text bold color="cyan">
              TIA Code
            </Text>
            <Text dimColor> · Pi coding harness</Text>
          </Text>
          <StatusBar modelName={modelName} />
        </Box>
      ) : null}
      <Thread modelName={modelName} directory={process.cwd()} />
      {hasMessages ? <Text dimColor>Ctrl+O to change the Pi provider or model.</Text> : null}
    </Box>
  );
};

const ConfiguredApp = ({
  configuration,
  onConfigure,
}: {
  configuration: PiConfiguration;
  onConfigure: () => void;
}) => {
  const provider = getProviderOption(configuration.providerId);
  const modelName = `${provider.label} · ${configuration.modelId}`;
  const adapter = useMemo(() => createPiAdapter(configuration), [configuration]);
  useEffect(
    () => () => {
      void adapter.dispose();
    },
    [adapter],
  );
  const runtime = useLocalRuntime(adapter);
  useInput((input, key) => {
    if (key.ctrl && (input.toLowerCase() === "o" || input === "\u000f")) onConfigure();
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Conversation modelName={modelName} />
    </AssistantRuntimeProvider>
  );
};

export const App = () => {
  const [configuration, setConfiguration] = useState<PiConfiguration | null | undefined>(undefined);
  const [showSetup, setShowSetup] = useState(false);

  useEffect(() => {
    let mounted = true;
    void loadPiConfiguration().then((loaded) => {
      if (mounted) setConfiguration(loaded);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (configuration === undefined) return <ConfigurationLoading />;

  if (showSetup || !configuration) {
    return (
      <PiSetup
        initialConfiguration={configuration ?? undefined}
        onComplete={(nextConfiguration) => {
          setConfiguration(nextConfiguration);
          setShowSetup(false);
        }}
        onCancel={configuration ? () => setShowSetup(false) : undefined}
      />
    );
  }

  return <ConfiguredApp configuration={configuration} onConfigure={() => setShowSetup(true)} />;
};
