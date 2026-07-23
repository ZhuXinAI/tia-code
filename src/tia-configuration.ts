import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const CONFIG_VERSION = 1;
const CONFIG_PATH_ENV = "TIA_CODE_CONFIG_PATH";
const RUNTIME_KEY_REFERENCE = "$TIA_CODE_API_KEY";
const TIA_AGENT_DIRECTORY = "tia";
const LEGACY_HARNESS_AGENT_DIRECTORY = "pi";

type TiaProviderApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export type TiaProviderId =
  | "anthropic"
  | "openai"
  | "deepseek"
  | "kimi"
  | "opencode-go"
  | "custom";

export const TIA_REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high"] as const;

export type TiaReasoningEffort = (typeof TIA_REASONING_EFFORTS)[number];

export const DEFAULT_TIA_REASONING_EFFORT: TiaReasoningEffort = "medium";

export type TiaProviderOption = {
  id: TiaProviderId;
  label: string;
  baseUrl?: string;
  api: TiaProviderApi;
  models: readonly string[];
};

export type TiaConfiguration = {
  version: typeof CONFIG_VERSION;
  providerId: TiaProviderId;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  reasoningEffort: TiaReasoningEffort;
};

export type TiaConfigurationOverrides = Partial<
  Pick<TiaConfiguration, "providerId" | "modelId" | "apiKey" | "baseUrl" | "reasoningEffort">
>;

export const TIA_PROVIDER_OPTIONS: readonly TiaProviderOption[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic-messages",
    models: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    id: "kimi",
    label: "Kimi",
    baseUrl: "https://api.kimi.com/coding/v1",
    api: "anthropic-messages",
    models: ["kimi-k2.5", "kimi-k3"],
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    api: "openai-completions",
    models: ["mimo-v2.5", "deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    api: "openai-completions",
    models: [],
  },
];

export const isTiaProviderId = (value: unknown): value is TiaProviderId =>
  typeof value === "string" && TIA_PROVIDER_OPTIONS.some((provider) => provider.id === value);

export const isTiaReasoningEffort = (value: unknown): value is TiaReasoningEffort =>
  typeof value === "string" && TIA_REASONING_EFFORTS.includes(value as TiaReasoningEffort);

export const getTiaProviderOption = (id: TiaProviderId): TiaProviderOption => {
  const provider = TIA_PROVIDER_OPTIONS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Unsupported TIA provider: ${id}`);
  return provider;
};

export const tiaConfigurationPath = (): string => {
  const override = process.env[CONFIG_PATH_ENV]?.trim();
  return override ? resolve(override) : join(homedir(), ".tia-code", "config.json");
};

export const tiaAgentDirectory = (): string =>
  join(dirname(tiaConfigurationPath()), TIA_AGENT_DIRECTORY);

const legacyHarnessAgentDirectory = (): string =>
  join(dirname(tiaConfigurationPath()), LEGACY_HARNESS_AGENT_DIRECTORY);

export const ensureTiaAgentDirectory = async (): Promise<string> => {
  const directory = tiaAgentDirectory();
  const legacyDirectory = legacyHarnessAgentDirectory();
  if (!existsSync(directory) && existsSync(legacyDirectory)) {
    try {
      await rename(legacyDirectory, directory);
    } catch (error) {
      if (!existsSync(directory)) throw error;
    }
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  return directory;
};

export const tiaSessionDirectory = (): string => join(tiaAgentDirectory(), "sessions");

export const ensureTiaSessionDirectory = async (): Promise<string> => {
  await ensureTiaAgentDirectory();
  const directory = tiaSessionDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  return directory;
};

export const isValidTiaBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const normalizeTiaConfiguration = (input: unknown): TiaConfiguration | null => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
  const reasoningEffort = isTiaReasoningEffort(value.reasoningEffort)
    ? value.reasoningEffort
    : DEFAULT_TIA_REASONING_EFFORT;
  if (
    value.version !== CONFIG_VERSION ||
    !isTiaProviderId(value.providerId) ||
    !apiKey ||
    !modelId ||
    (baseUrl && !isValidTiaBaseUrl(baseUrl)) ||
    (value.providerId === "custom" && !baseUrl)
  ) {
    return null;
  }
  return {
    version: CONFIG_VERSION,
    providerId: value.providerId,
    modelId,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    reasoningEffort,
  };
};

export const resolveTiaConfiguration = (
  saved: TiaConfiguration | null,
  overrides: TiaConfigurationOverrides = {},
): TiaConfiguration | null => {
  const providerId = overrides.providerId ?? saved?.providerId;
  const apiKey = overrides.apiKey ?? saved?.apiKey;
  const modelId = overrides.modelId ?? saved?.modelId;
  if (!providerId || !apiKey || !modelId) return null;

  const providerChanged = providerId !== saved?.providerId;
  const baseUrl = overrides.baseUrl ?? (providerChanged ? undefined : saved?.baseUrl);
  return normalizeTiaConfiguration({
    version: CONFIG_VERSION,
    providerId,
    apiKey,
    modelId,
    baseUrl,
    reasoningEffort: overrides.reasoningEffort ?? saved?.reasoningEffort,
  });
};

export const loadTiaConfiguration = async (
  path = tiaConfigurationPath(),
): Promise<TiaConfiguration | null> => {
  try {
    return normalizeTiaConfiguration(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
};

export const saveTiaConfiguration = async (
  configuration: TiaConfiguration,
  path = tiaConfigurationPath(),
): Promise<TiaConfiguration> => {
  const normalized = normalizeTiaConfiguration(configuration);
  if (!normalized) throw new Error("A provider, model, and API key are required.");

  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600).catch(() => undefined);
  return normalized;
};

export const createTiaModelRuntime = async (configuration: TiaConfiguration) => {
  const normalized = normalizeTiaConfiguration(configuration);
  if (!normalized) throw new Error("TIA has not been configured yet.");

  const provider = getTiaProviderOption(normalized.providerId);
  const baseUrl = normalized.baseUrl ?? provider.baseUrl;
  if (!baseUrl) throw new Error("A custom TIA provider requires a base URL.");
  const agentDir = await ensureTiaAgentDirectory();

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const providerId = `tia-code-${provider.id}`;
  modelRuntime.registerProvider(providerId, {
    name: provider.label,
    baseUrl,
    api: provider.api,
    apiKey: RUNTIME_KEY_REFERENCE,
    authHeader: true,
    models: [
      {
        id: normalized.modelId,
        name: normalized.modelId,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey(providerId, normalized.apiKey);

  const model = modelRuntime.getModel(providerId, normalized.modelId);
  if (!model) throw new Error(`TIA could not load ${provider.label}/${normalized.modelId}.`);

  return { agentDir, modelRuntime, model, providerId };
};
