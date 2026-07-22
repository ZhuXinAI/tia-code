import { useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  TIA_PROVIDER_OPTIONS,
  saveTiaConfiguration,
  type TiaConfiguration,
  type TiaProviderOption,
} from "../tia-configuration.js";

type SetupStep = "provider" | "api-key" | "model" | "custom-model";

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
  const [customModel, setCustomModel] = useState(initialModelSelection.customModel);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const provider = TIA_PROVIDER_OPTIONS[providerIndex]!;
  const canReuseSavedKey = initialConfiguration?.providerId === provider.id && !!initialConfiguration.apiKey;
  const modelOptions = [...provider.models, customModelOption];

  const goToProvider = () => {
    setError(undefined);
    setStep("provider");
  };

  const goToApiKey = () => {
    const nextSelection = modelSelectionFor(provider, initialConfiguration);
    setModelIndex(nextSelection.modelIndex);
    setCustomModel(nextSelection.customModel);
    setApiKeyInput("");
    setError(undefined);
    setStep("api-key");
  };

  const save = (modelId: string) => {
    const apiKey = apiKeyInput.trim() || (canReuseSavedKey ? initialConfiguration?.apiKey : "");
    if (!apiKey) {
      setError("Paste an API key to continue.");
      setStep("api-key");
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
        if (apiKeyInput.trim() || canReuseSavedKey) {
          setError(undefined);
          setStep("model");
        } else {
          setError("Paste an API key to continue.");
        }
      } else if (key.backspace || key.delete) {
        setApiKeyInput((value) => value.slice(0, -1));
      } else if (key.ctrl && input.toLowerCase() === "u") {
        setApiKeyInput("");
      } else if (!key.ctrl && !key.meta && input) {
        setApiKeyInput((value) => `${value}${input}`);
      }
      return;
    }

    if (step === "model") {
      if (key.upArrow) {
        setModelIndex((current) => (current === 0 ? modelOptions.length - 1 : current - 1));
      } else if (key.downArrow) {
        setModelIndex((current) => (current + 1) % modelOptions.length);
      } else if (key.return) {
        const selectedModel = modelOptions[modelIndex];
        if (selectedModel === customModelOption) {
          setError(undefined);
          setStep("custom-model");
        } else if (selectedModel) {
          save(selectedModel);
        }
      } else if (key.escape) {
        setError(undefined);
        setStep("api-key");
      }
      return;
    }

    if (key.escape) {
      setError(undefined);
      setStep("model");
    } else if (key.return) {
      save(customModel);
    } else if (key.backspace || key.delete) {
      setCustomModel((value) => value.slice(0, -1));
    } else if (key.ctrl && input.toLowerCase() === "u") {
      setCustomModel("");
    } else if (!key.ctrl && !key.meta && input) {
      setCustomModel((value) => `${value}${input}`);
    }
  });

  const heading = initialConfiguration ? "Update TIA model" : "Set up TIA";

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
          <Text color="cyan">1/3 · Choose a provider</Text>
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
          <Text color="cyan">2/3 · {provider.label} API key</Text>
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

      {!saving && step === "model" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">3/3 · Choose a model for {provider.label}</Text>
          {modelOptions.map((model, index) => (
            <Text key={model} color={index === modelIndex ? "cyan" : undefined}>
              {selectedMarker(index === modelIndex)} {model}
            </Text>
          ))}
          <Text dimColor>↑/↓ choose · Enter save · Esc goes back</Text>
        </Box>
      ) : null}

      {!saving && step === "custom-model" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">3/3 · Custom {provider.label} model ID</Text>
          <Box borderStyle="round" borderColor={error ? "red" : "gray"} paddingX={1}>
            <Text color="gray">{"> "}</Text>
            <Text>{customModel}</Text>
            {!customModel ? <Text dimColor>e.g. my-provider-model</Text> : null}
          </Box>
          <Text dimColor>Enter save · Esc goes back</Text>
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
