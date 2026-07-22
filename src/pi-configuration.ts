import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const CONFIG_VERSION = 1;
const CONFIG_PATH_ENV = "TIA_CODE_CONFIG_PATH";
const RUNTIME_KEY_REFERENCE = "$TIA_CODE_API_KEY";

type PiProviderApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export type PiProviderId = "anthropic" | "openai" | "deepseek" | "kimi" | "opencode-go";

export type PiProviderOption = {
  id: PiProviderId;
  label: string;
  baseUrl: string;
  api: PiProviderApi;
  models: readonly string[];
};

export type PiConfiguration = {
  version: typeof CONFIG_VERSION;
  providerId: PiProviderId;
  modelId: string;
  apiKey: string;
};

export const PI_PROVIDER_OPTIONS: readonly PiProviderOption[] = [
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
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "kimi",
    label: "Kimi",
    baseUrl: "https://api.kimi.com/coding/v1",
    api: "anthropic-messages",
    models: ["kimi-k2.5"],
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    api: "openai-completions",
    models: ["mimo-v2.5"],
  },
];

const isProviderId = (value: unknown): value is PiProviderId =>
  typeof value === "string" && PI_PROVIDER_OPTIONS.some((provider) => provider.id === value);

export const getProviderOption = (id: PiProviderId): PiProviderOption => {
  const provider = PI_PROVIDER_OPTIONS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Unsupported Pi provider: ${id}`);
  return provider;
};

export const piConfigurationPath = (): string => {
  const override = process.env[CONFIG_PATH_ENV]?.trim();
  return override ? resolve(override) : join(homedir(), ".tia-code", "config.json");
};

export const piAgentDirectory = (): string => join(dirname(piConfigurationPath()), "pi");

export const piSessionDirectory = (): string => join(piAgentDirectory(), "sessions");

export const ensurePiSessionDirectory = async (): Promise<string> => {
  const directory = piSessionDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  return directory;
};

const normalizeConfiguration = (input: unknown): PiConfiguration | null => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
  if (value.version !== CONFIG_VERSION || !isProviderId(value.providerId) || !apiKey || !modelId) {
    return null;
  }
  return { version: CONFIG_VERSION, providerId: value.providerId, modelId, apiKey };
};

export const loadPiConfiguration = async (
  path = piConfigurationPath(),
): Promise<PiConfiguration | null> => {
  try {
    return normalizeConfiguration(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
};

export const savePiConfiguration = async (
  configuration: PiConfiguration,
  path = piConfigurationPath(),
): Promise<PiConfiguration> => {
  const normalized = normalizeConfiguration(configuration);
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

export const createPiModelRuntime = async (configuration: PiConfiguration) => {
  const normalized = normalizeConfiguration(configuration);
  if (!normalized) throw new Error("Pi has not been configured yet.");

  const provider = getProviderOption(normalized.providerId);
  const agentDir = piAgentDirectory();
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await chmod(agentDir, 0o700).catch(() => undefined);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const providerId = `tia-code-${provider.id}`;
  modelRuntime.registerProvider(providerId, {
    name: provider.label,
    baseUrl: provider.baseUrl,
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
  if (!model) throw new Error(`Pi could not load ${provider.label}/${normalized.modelId}.`);

  return { agentDir, modelRuntime, model, providerId };
};
