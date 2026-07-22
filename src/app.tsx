import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, type Key } from "ink";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useAuiState,
  StatusBarPrimitive,
  type ThreadMessageLike,
} from "@assistant-ui/react-ink";
import { Thread } from "./components/thread.js";
import { PiSetup } from "./components/pi-setup.js";
import { createPiAdapter } from "./pi-adapter.js";
import {
  getProviderOption,
  loadPiConfiguration,
  type PiConfiguration,
} from "./pi-configuration.js";
import type { PiSessionExitSummary } from "./session-exit.js";

type PiAdapter = ReturnType<typeof createPiAdapter>;

type PreparedRuntime = {
  adapter: PiAdapter;
  initialMessages: readonly ThreadMessageLike[];
};

type InitializationError = {
  adapter: PiAdapter;
  message: string;
};

export type TiaCodeExitResult = {
  session?: PiSessionExitSummary;
  error?: string;
};

const isCtrlC = (input: string, key: Key): boolean =>
  input === "\u0003" || (key.ctrl && input.toLowerCase() === "c");

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

const SessionLoading = () => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="cyan">
      TIA Code
    </Text>
    <Text dimColor>Opening your Pi session…</Text>
  </Box>
);

const SessionError = ({ message }: { message: string }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="red">
      TIA Code could not open this Pi session
    </Text>
    <Text>{message}</Text>
    <Text dimColor>Press Ctrl+C to exit.</Text>
  </Box>
);

const ExitOnCtrlC = () => {
  const { exit } = useApp();
  useInput((input, key) => {
    if (isCtrlC(input, key)) exit();
  });
  return null;
};

const SessionExitOnCtrlC = ({ adapter }: { adapter: PiAdapter }) => {
  const { exit } = useApp();
  const [isExiting, setIsExiting] = useState(false);
  useInput((input, key) => {
    if (!isCtrlC(input, key) || isExiting) return;
    setIsExiting(true);
    void adapter.dispose().then(
      (session) => exit({ session } satisfies TiaCodeExitResult),
      (error: unknown) =>
        exit({
          error: error instanceof Error ? error.message : String(error),
        } satisfies TiaCodeExitResult),
    );
  });
  return null;
};

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
      <Text dimColor>
        {hasMessages
          ? "Ctrl+O to change the Pi provider or model · Ctrl+C to exit."
          : "Ctrl+C to exit."}
      </Text>
    </Box>
  );
};

const ActiveConfiguredApp = ({
  adapter,
  initialMessages,
  modelName,
  onConfigure,
}: {
  adapter: PiAdapter;
  initialMessages: readonly ThreadMessageLike[];
  modelName: string;
  onConfigure: () => void;
}) => {
  const runtime = useLocalRuntime(adapter, { initialMessages });
  const { exit } = useApp();
  const [isExiting, setIsExiting] = useState(false);

  useInput((input, key) => {
    if (isCtrlC(input, key)) {
      if (isExiting) return;
      setIsExiting(true);
      void adapter.dispose().then(
        (session) => exit({ session } satisfies TiaCodeExitResult),
        (error: unknown) =>
          exit({
            error: error instanceof Error ? error.message : String(error),
          } satisfies TiaCodeExitResult),
      );
      return;
    }
    if (!isExiting && key.ctrl && (input.toLowerCase() === "o" || input === "\u000f")) {
      onConfigure();
    }
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Conversation modelName={modelName} />
    </AssistantRuntimeProvider>
  );
};

const ConfiguredApp = ({
  configuration,
  onConfigure,
  resumeSessionId,
}: {
  configuration: PiConfiguration;
  onConfigure: () => void;
  resumeSessionId?: string;
}) => {
  const provider = getProviderOption(configuration.providerId);
  const modelName = `${provider.label} · ${configuration.modelId}`;
  const adapter = useMemo(
    () => createPiAdapter(configuration, process.cwd(), { resumeSessionId }),
    [configuration, resumeSessionId],
  );
  const [prepared, setPrepared] = useState<PreparedRuntime | undefined>(undefined);
  const [initializationError, setInitializationError] = useState<InitializationError | undefined>(
    undefined,
  );

  useEffect(() => {
    let mounted = true;
    void adapter.initialize().then(
      (initialMessages) => {
        if (mounted) setPrepared({ adapter, initialMessages });
      },
      (error: unknown) => {
        if (mounted) {
          setInitializationError({
            adapter,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      mounted = false;
      void adapter.dispose();
    };
  }, [adapter]);

  if (initializationError?.adapter === adapter) {
    return (
      <>
        <SessionExitOnCtrlC adapter={adapter} />
        <SessionError message={initializationError.message} />
      </>
    );
  }

  if (prepared?.adapter !== adapter) {
    return (
      <>
        <SessionExitOnCtrlC adapter={adapter} />
        <SessionLoading />
      </>
    );
  }

  return (
    <ActiveConfiguredApp
      adapter={adapter}
      initialMessages={prepared.initialMessages}
      modelName={modelName}
      onConfigure={onConfigure}
    />
  );
};

export const App = ({ resumeSessionId }: { resumeSessionId?: string }) => {
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

  if (configuration === undefined) {
    return (
      <>
        <ExitOnCtrlC />
        <ConfigurationLoading />
      </>
    );
  }

  if (showSetup || !configuration) {
    return (
      <>
        <ExitOnCtrlC />
        <PiSetup
          initialConfiguration={configuration ?? undefined}
          onComplete={(nextConfiguration) => {
            setConfiguration(nextConfiguration);
            setShowSetup(false);
          }}
          onCancel={configuration ? () => setShowSetup(false) : undefined}
        />
      </>
    );
  }

  return (
    <ConfiguredApp
      configuration={configuration}
      onConfigure={() => setShowSetup(true)}
      resumeSessionId={resumeSessionId}
    />
  );
};
