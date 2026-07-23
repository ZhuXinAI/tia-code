import { createTiaAdapter } from "./tia-adapter.js";
import {
  loadTiaConfiguration,
  resolveTiaConfiguration,
  type TiaConfigurationOverrides,
} from "./tia-configuration.js";

/**
 * Runs one prompt without Ink. Only assistant text deltas are sent to the
 * callback, keeping stdout suitable for pipes and command substitution.
 */
export const runTiaCodePrompt = async (
  prompt: string,
  onTextDelta: (delta: string) => void,
  overrides: TiaConfigurationOverrides = {},
): Promise<void> => {
  const configuration = resolveTiaConfiguration(await loadTiaConfiguration(), overrides);
  if (!configuration) {
    throw new Error(
      "TIA Code needs a provider, API key, and model. Run `tia-code setup` or pass --provider, --api-key, and --model-id.",
    );
  }

  const adapter = createTiaAdapter(configuration, process.cwd());

  try {
    await adapter.runPrompt(prompt, (delta) => {
      onTextDelta(delta);
    });
  } finally {
    await adapter.dispose();
  }
};
