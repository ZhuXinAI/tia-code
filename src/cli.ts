import {
  DEFAULT_TIA_REASONING_EFFORT,
  isTiaProviderId,
  isTiaReasoningEffort,
  isValidTiaBaseUrl,
  TIA_PROVIDER_OPTIONS,
  type TiaConfiguration,
  type TiaConfigurationOverrides,
  type TiaProviderId,
  type TiaReasoningEffort,
} from "./tia-configuration.js";

export type TiaSetupConfiguration = Omit<TiaConfiguration, "version">;

export type TiaCodeCommand =
  | { type: "interactive"; resumeSessionId?: string }
  | { type: "run"; prompt: string; configuration?: TiaConfigurationOverrides }
  | { type: "mcp"; args: string[] }
  | { type: "setup"; configuration?: TiaSetupConfiguration }
  | { type: "help" };

export const TIA_CODE_USAGE = `Usage:
  tia-code
  tia-code setup
  tia-code setup [--provider <provider>] [--api-key <api-key>] [--model-id <model-id>] [--base-url <url>] [--reasoning-effort <effort>]
  tia-code resume <session-id>
  tia-code run <prompt> [--provider <provider>] [--api-key <api-key>] [--model-id <model-id>] [--base-url <url>] [--reasoning-effort <effort>]
  tia-code mcp <command> [options]

Commands:
  setup [options]      Choose a provider, API key, base URL, model, and reasoning effort. Set all required values to save without the terminal UI.
  mcp <command>         Manage MCP servers, for example: mcp add stripe --url https://mcp.stripe.com
  run <prompt>          Run TIA without the terminal UI; connection options apply only to this run.
  resume <session-id>   Open a saved session in the terminal UI.
  --help, -h            Show this help.

Connection options:
  --provider <provider>             anthropic, openai, deepseek, kimi, opencode-go, or custom
  --api-key <api-key>               Provider API key
  --model-id <model-id>             Provider model ID
  --base-url <url>                  Override the provider endpoint; required for custom
  --reasoning-effort <effort>       off, minimal, low, medium, or high

Environment fallbacks:
  TIA_CODE_PROVIDER, TIA_CODE_API_KEY, TIA_CODE_MODEL_ID, TIA_CODE_BASE_URL, TIA_CODE_REASONING_EFFORT
  Explicit command-line options take precedence over these variables.`;

const connectionOptionNames = {
  "--provider": "providerId",
  "--api-key": "apiKey",
  "--model-id": "modelId",
  "--base-url": "baseUrl",
  "--reasoning-effort": "reasoningEffort",
} as const;

type ConnectionOptionName = keyof typeof connectionOptionNames;
type ConnectionValueKey = (typeof connectionOptionNames)[ConnectionOptionName];
type ConnectionValues = Partial<Record<ConnectionValueKey, string>>;

type ParsedConnectionArguments = {
  values: ConnectionValues;
  positionals: string[];
  hasInput: boolean;
};

const isConnectionOptionName = (value: string): value is ConnectionOptionName =>
  value in connectionOptionNames;

const connectionUsageError = (message: string): Error => new Error(`${message}\n\n${TIA_CODE_USAGE}`);

const valueFromEnvironment = (value: string | undefined): string | undefined => value?.trim() || undefined;

const environmentConnectionValues = (environment: NodeJS.ProcessEnv): ConnectionValues => ({
  providerId: valueFromEnvironment(environment.TIA_CODE_PROVIDER),
  apiKey: valueFromEnvironment(environment.TIA_CODE_API_KEY),
  modelId: valueFromEnvironment(environment.TIA_CODE_MODEL_ID),
  baseUrl: valueFromEnvironment(environment.TIA_CODE_BASE_URL),
  reasoningEffort: valueFromEnvironment(environment.TIA_CODE_REASONING_EFFORT),
});

const validateConnectionValues = (values: ConnectionValues): void => {
  if (values.providerId && !isTiaProviderId(values.providerId)) {
    throw connectionUsageError(
      `Unsupported provider: ${values.providerId}. Available providers: ${TIA_PROVIDER_OPTIONS.map((provider) => provider.id).join(", ")}.`,
    );
  }
  if (values.baseUrl && !isValidTiaBaseUrl(values.baseUrl)) {
    throw connectionUsageError("--base-url and TIA_CODE_BASE_URL must be an http(s) URL.");
  }
  if (values.reasoningEffort && !isTiaReasoningEffort(values.reasoningEffort)) {
    throw connectionUsageError(
      "--reasoning-effort and TIA_CODE_REASONING_EFFORT must be off, minimal, low, medium, or high.",
    );
  }
};

const toConfigurationOverrides = (values: ConnectionValues): TiaConfigurationOverrides => {
  const overrides: TiaConfigurationOverrides = {};
  if (values.providerId) overrides.providerId = values.providerId as TiaProviderId;
  if (values.apiKey) overrides.apiKey = values.apiKey;
  if (values.modelId) overrides.modelId = values.modelId;
  if (values.baseUrl) overrides.baseUrl = values.baseUrl;
  if (values.reasoningEffort) {
    overrides.reasoningEffort = values.reasoningEffort as TiaReasoningEffort;
  }
  return overrides;
};

const parseConnectionArguments = (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): ParsedConnectionArguments => {
  const cliValues: ConnectionValues = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }

    const separator = argument.indexOf("=");
    const optionName = separator >= 0 ? argument.slice(0, separator) : argument;
    if (!optionName.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (!isConnectionOptionName(optionName)) {
      throw connectionUsageError(`Unknown connection option: ${argument}`);
    }

    const nextArgument = args[index + 1];
    const nextOptionName = nextArgument?.split("=", 1)[0] ?? "";
    const rawValue =
      separator >= 0
        ? argument.slice(separator + 1)
        : nextArgument && nextArgument !== "--" && !nextOptionName.startsWith("--")
          ? args[++index]
          : undefined;
    const value = rawValue?.trim();
    if (!value) throw connectionUsageError(`${optionName} requires a value.`);

    const key = connectionOptionNames[optionName];
    if (cliValues[key] !== undefined) {
      throw connectionUsageError(`${optionName} can only be specified once.`);
    }
    cliValues[key] = value;
  }

  const environmentValues = environmentConnectionValues(environment);
  const values: ConnectionValues = {
    providerId: cliValues.providerId ?? environmentValues.providerId,
    apiKey: cliValues.apiKey ?? environmentValues.apiKey,
    modelId: cliValues.modelId ?? environmentValues.modelId,
    baseUrl: cliValues.baseUrl ?? environmentValues.baseUrl,
    reasoningEffort: cliValues.reasoningEffort ?? environmentValues.reasoningEffort,
  };
  validateConnectionValues(values);
  return {
    values,
    positionals,
    hasInput: Object.values(cliValues).some(Boolean) || Object.values(environmentValues).some(Boolean),
  };
};

const parseSetupCommand = (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): TiaCodeCommand => {
  const parsed = parseConnectionArguments(args, environment);
  if (parsed.positionals.length > 0) {
    throw connectionUsageError(`Unexpected setup argument: ${parsed.positionals[0]}`);
  }
  if (!parsed.hasInput) return { type: "setup" };

  const { providerId, apiKey, modelId, baseUrl, reasoningEffort } = parsed.values;
  if (!providerId || !apiKey || !modelId) {
    throw connectionUsageError(
      "Non-interactive setup requires a provider, API key, and model ID through options or TIA_CODE_PROVIDER, TIA_CODE_API_KEY, and TIA_CODE_MODEL_ID.",
    );
  }
  if (providerId === "custom" && !baseUrl) {
    throw connectionUsageError("Custom providers require --base-url or TIA_CODE_BASE_URL.");
  }

  return {
    type: "setup",
    configuration: {
      providerId: providerId as TiaProviderId,
      apiKey,
      modelId,
      ...(baseUrl ? { baseUrl } : {}),
      reasoningEffort: (reasoningEffort as TiaReasoningEffort | undefined) ??
        DEFAULT_TIA_REASONING_EFFORT,
    },
  };
};

const parseRunCommand = (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): TiaCodeCommand => {
  const parsed = parseConnectionArguments(args, environment);
  const prompt = parsed.positionals.join(" ").trim();
  if (!prompt) throw new Error(TIA_CODE_USAGE);
  if (parsed.values.providerId === "custom" && !parsed.values.baseUrl) {
    throw connectionUsageError("Custom providers require --base-url or TIA_CODE_BASE_URL.");
  }

  const configuration = toConfigurationOverrides(parsed.values);
  return {
    type: "run",
    prompt,
    ...(parsed.hasInput ? { configuration } : {}),
  };
};

export const parseTiaCodeCommand = (
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): TiaCodeCommand => {
  const commandArgs = args[0] === "--" ? args.slice(1) : args;
  if (commandArgs.length === 0) return { type: "interactive" };

  if (
    commandArgs.length === 1 &&
    (commandArgs[0] === "--help" || commandArgs[0] === "-h" || commandArgs[0] === "help")
  ) {
    return { type: "help" };
  }

  if (commandArgs[0] === "run") {
    return parseRunCommand(commandArgs.slice(1), environment);
  }

  if (commandArgs[0] === "mcp") {
    return { type: "mcp", args: commandArgs.slice(1) };
  }

  if (commandArgs[0] === "setup") {
    return parseSetupCommand(commandArgs.slice(1), environment);
  }

  if (commandArgs[0] === "resume" && commandArgs.length === 2 && commandArgs[1]?.trim()) {
    return { type: "interactive", resumeSessionId: commandArgs[1].trim() };
  }

  throw new Error(TIA_CODE_USAGE);
};
