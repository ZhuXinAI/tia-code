import { useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  DEFAULT_TIA_REASONING_EFFORT,
  isValidTiaBaseUrl,
  TIA_PROVIDER_OPTIONS,
  TIA_REASONING_EFFORTS,
  saveTiaConfiguration,
  type TiaConfiguration,
  type TiaProviderOption,
} from "../tia-configuration.js";

type SetupStep = "provider" | "api-key" | "base-url" | "model" | "custom-model" | "reasoning-effort";

type TiaSetupProps = {
  initialConfiguration?: TiaConfiguration;
  onComplete: (configuration: TiaConfiguration) => void;
  onCancel?: () => void;
};

const customModelOption = "Custom model ID";

const selectedMarker = (selected: boolean): string => (selected ? "›" : " ");

const modelSelectionFor = (
  provider: TiaProviderOption,
  configuration?: TiaConfiguration,
): { modelIndex: number; customModel: string } => {
  const configuredModel = configuration?.providerId === provider.id ? configuration.modelId : "";
  if (!configuredModel) return { modelIndex: 0, customModel: "" };
  const modelIndex = provider.models.indexOf(configuredModel);
  return {
    modelIndex: modelIndex >= 0 ? modelIndex : provider.models.length,
    customModel: modelIndex >= 0 ? "" : configuredModel,
  };
};

const baseUrlOverrideFor = (provider: TiaProviderOption, configuration?: TiaConfiguration): string =>
  configuration?.providerId === provider.id ? configuration.baseUrl ?? "" : "";

const reasoningEffortIndexFor = (configuration?: TiaConfiguration): number => {
  const savedEffort = configuration?.reasoningEffort ?? DEFAULT_TIA_REASONING_EFFORT;
  return Math.max(0, TIA_REASONING_EFFORTS.indexOf(savedEffort));
};

const maskedKey = (value: string): string => (value ? "••••••••" : "");

export const TiaSetup = ({ initialConfiguration, onComplete, onCancel }: TiaSetupProps) => {
  const initialProviderIndex = Math.max(
    0,
    TIA_PROVIDER_OPTIONS.findIndex((provider) => provider.id === initialConfiguration?.providerId),
  );
  const initialProvider = TIA_PROVIDER_OPTIONS[initialProviderIndex]!;
  const initialModelSelection = modelSelectionFor(initialProvider, initialConfiguration);
  const [step, setStep] = useState<SetupStep>("provider");
  const [providerIndex, setProviderIndex] = useState(initialProviderIndex);
  const [modelIndex, setModelIndex] = useState(initialModelSelection.modelIndex);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState(
    baseUrlOverrideFor(initialProvider, initialConfiguration),
  );
  const [customModel, setCustomModel] = useState(initialModelSelection.customModel);
  const [reasoningEffortIndex, setReasoningEffortIndex] = useState(
    reasoningEffortIndexFor(initialConfiguration),
  );
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const provider = TIA_PROVIDER_OPTIONS[providerIndex]!;
  const canReuseSavedKey = initialConfiguration?.providerId === provider.id && !!initialConfiguration.apiKey;
  const modelOptions = [...provider.models, customModelOption];
  const selectedModel = modelOptions[modelIndex];

  const goToProvider = () => {
    setError(undefined);
    setStep("provider");
  };

  const goToApiKey = () => {
    const nextSelection = modelSelectionFor(provider, initialConfiguration);
    setModelIndex(nextSelection.modelIndex);
    setCustomModel(nextSelection.customModel);
    setBaseUrlInput(baseUrlOverrideFor(provider, initialConfiguration));
    setApiKeyInput("");
    setError(undefined);
    setStep("api-key");
  };

  const goToBaseUrl = () => {
    if (!apiKeyInput.trim() && !canReuseSavedKey) {
      setError("Paste an API key to continue.");
      return;
    }
    setError(undefined);
    setStep("base-url");
  };

  const goToModel = () => {
    const baseUrl = baseUrlInput.trim();
    if (baseUrl && !isValidTiaBaseUrl(baseUrl)) {
      setError("Enter an http(s) base URL.");
      return;
    }
    if (provider.id === "custom" && !baseUrl) {
      setError("A custom provider requires a base URL.");
      return;
    }
    setError(undefined);
    setStep("model");
  };

  const goToReasoningEffort = (modelId: string) => {
    if (!modelId.trim()) {
      setError("Enter a model ID to continue.");
      setStep("custom-model");
      return;
    }
    setError(undefined);
    setStep("reasoning-effort");
  };

  const save = (modelId: string) => {
    const apiKey = apiKeyInput.trim() || (canReuseSavedKey ? initialConfiguration?.apiKey : "");
    const baseUrl = baseUrlInput.trim();
    if (!apiKey) {
      setError("Paste an API key to continue.");
      setStep("api-key");
      return;
    }
    if (baseUrl && !isValidTiaBaseUrl(baseUrl)) {
      setError("Enter an http(s) base URL.");
      setStep("base-url");
      return;
    }
    if (provider.id === "custom" && !baseUrl) {
      setError("A custom provider requires a base URL.");
      setStep("base-url");
      return;
    }
    if (!modelId.trim()) {
      setError("Enter a model ID to continue.");
      setStep("custom-model");
      return;
    }

    const configuration: TiaConfiguration = {
      version: 1,
      providerId: provider.id,
      modelId: modelId.trim(),
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      reasoningEffort: TIA_REASONING_EFFORTS[reasoningEffortIndex]!,
    };
    setError(undefined);
    setSaving(true);
    void saveTiaConfiguration(configuration).then(onComplete, (cause: unknown) => {
      setSaving(false);
      setError(cause instanceof Error ? cause.message : "Could not save the TIA configuration.");
    });
  };

  useInput((input, key) => {
    if (saving) return;

    if (step === "provider") {
      if (key.upArrow) {
        setProviderIndex((current) =>
          current === 0 ? TIA_PROVIDER_OPTIONS.length - 1 : current - 1,
        );
      } else if (key.downArrow) {
        setProviderIndex((current) => (current + 1) % TIA_PROVIDER_OPTIONS.length);
      } else if (key.return) {
        goToApiKey();
      } else if (key.escape) {
        onCancel?.();
      }
      return;
    }

    if (step === "api-key") {
      if (key.escape) {
        goToProvider();
      } else if (key.return) {
        goToBaseUrl();
      } else if (key.backspace || key.delete) {
        setApiKeyInput((value) => value.slice(0, -1));
      } else if (key.ctrl && input.toLowerCase() === "u") {
        setApiKeyInput("");
      } else if (!key.ctrl && !key.meta && input) {
        setApiKeyInput((value) => `${value}${input}`);
      }
      return;
    }

    if (step === "base-url") {
      if (key.escape) {
        setError(undefined);
        setStep("api-key");
      } else if (key.return) {
        goToModel();
      } else if (key.backspace || key.delete) {
        setBaseUrlInput((value) => value.slice(0, -1));
      } else if (key.ctrl && input.toLowerCase() === "u") {
        setBaseUrlInput("");
      } else if (!key.ctrl && !key.meta && input) {
        setBaseUrlInput((value) => `${value}${input}`);
      }
      return;
    }

    if (step === "model") {
      if (key.upArrow) {
        setModelIndex((current) => (current === 0 ? modelOptions.length - 1 : current - 1));
      } else if (key.downArrow) {
        setModelIndex((current) => (current + 1) % modelOptions.length);
      } else if (key.return) {
        if (selectedModel === customModelOption) {
          setError(undefined);
          setStep("custom-model");
        } else if (selectedModel) {
          goToReasoningEffort(selectedModel);
        }
      } else if (key.escape) {
        setError(undefined);
        setStep("base-url");
      }
      return;
    }

    if (step === "custom-model") {
      if (key.escape) {
        setError(undefined);
        setStep("model");
      } else if (key.return) {
        goToReasoningEffort(customModel);
      } else if (key.backspace || key.delete) {
        setCustomModel((value) => value.slice(0, -1));
      } else if (key.ctrl && input.toLowerCase() === "u") {
        setCustomModel("");
      } else if (!key.ctrl && !key.meta && input) {
        setCustomModel((value) => `${value}${input}`);
      }
      return;
    }

    if (key.upArrow) {
      setReasoningEffortIndex((current) =>
        current === 0 ? TIA_REASONING_EFFORTS.length - 1 : current - 1,
      );
    } else if (key.downArrow) {
      setReasoningEffortIndex((current) => (current + 1) % TIA_REASONING_EFFORTS.length);
    } else if (key.return) {
      save(selectedModel === customModelOption ? customModel : selectedModel ?? "");
    } else if (key.escape) {
      setError(undefined);
      setStep(selectedModel === customModelOption ? "custom-model" : "model");
    }
  });

  const heading = initialConfiguration ? "Update TIA configuration" : "Set up TIA";
  const baseUrlPlaceholder =
    provider.id === "custom"
      ? "https://your-provider.example/v1"
      : `Leave blank to use ${provider.baseUrl}`;

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        TIA Code
      </Text>
      <Text bold>{heading}</Text>
      <Text dimColor>
        TIA runs locally in this workspace. Your API key is stored only in TIA Code’s local config.
      </Text>

      {saving ? (
        <Box marginTop={1}>
          <Text color="yellow">Saving configuration…</Text>
        </Box>
      ) : null}

      {!saving && step === "provider" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">1/5 · Choose a provider</Text>
          {TIA_PROVIDER_OPTIONS.map((option, index) => (
            <Text key={option.id} color={index === providerIndex ? "cyan" : undefined}>
              {selectedMarker(index === providerIndex)} {option.label}
            </Text>
          ))}
          <Text dimColor>↑/↓ choose · Enter continue{onCancel ? " · Esc cancel" : ""}</Text>
        </Box>
      ) : null}

      {!saving && step === "api-key" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">2/5 · {provider.label} API key</Text>
          <Box borderStyle="round" borderColor={error ? "red" : "gray"} paddingX={1}>
            <Text color="gray">{"> "}</Text>
            <Text>{maskedKey(apiKeyInput)}</Text>
            {!apiKeyInput ? <Text dimColor>Paste API key</Text> : null}
          </Box>
          <Text dimColor>
            {canReuseSavedKey
              ? "Leave blank to keep the saved key. Enter continues · Esc goes back."
              : "The key is masked while you type. Enter continues · Esc goes back."}
          </Text>
        </Box>
      ) : null}

      {!saving && step === "base-url" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">3/5 · {provider.label} base URL</Text>
          <Box borderStyle="round" borderColor={error ? "red" : "gray"} paddingX={1}>
            <Text color="gray">{"> "}</Text>
            <Text>{baseUrlInput}</Text>
            {!baseUrlInput ? <Text dimColor>{baseUrlPlaceholder}</Text> : null}
          </Box>
          <Text dimColor>
            {provider.id === "custom"
              ? "Required for custom providers. Enter continues · Esc goes back."
              : "Optional provider endpoint override. Enter continues · Esc goes back."}
          </Text>
        </Box>
      ) : null}

      {!saving && step === "model" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">4/5 · Choose a model for {provider.label}</Text>
          {modelOptions.map((model, index) => (
            <Text key={model} color={index === modelIndex ? "cyan" : undefined}>
              {selectedMarker(index === modelIndex)} {model}
            </Text>
          ))}
          <Text dimColor>↑/↓ choose · Enter continue · Esc goes back</Text>
        </Box>
      ) : null}

      {!saving && step === "custom-model" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">4/5 · Custom {provider.label} model ID</Text>
          <Box borderStyle="round" borderColor={error ? "red" : "gray"} paddingX={1}>
            <Text color="gray">{"> "}</Text>
            <Text>{customModel}</Text>
            {!customModel ? <Text dimColor>e.g. my-provider-model</Text> : null}
          </Box>
          <Text dimColor>Enter continues · Esc goes back</Text>
        </Box>
      ) : null}

      {!saving && step === "reasoning-effort" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">5/5 · Choose a reasoning effort</Text>
          {TIA_REASONING_EFFORTS.map((effort, index) => (
            <Text key={effort} color={index === reasoningEffortIndex ? "cyan" : undefined}>
              {selectedMarker(index === reasoningEffortIndex)} {effort}
            </Text>
          ))}
          <Text dimColor>↑/↓ choose · Enter save · Esc goes back</Text>
        </Box>
      ) : null}

      {error ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
