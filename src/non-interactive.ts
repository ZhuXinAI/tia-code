import { createTiaAdapter } from "./tia-adapter.js";
import { loadTiaConfiguration } from "./tia-configuration.js";

/**
 * Runs one prompt without Ink. Only assistant text deltas are sent to the
 * callback, keeping stdout suitable for pipes and command substitution.
 */
export const runTiaCodePrompt = async (
  prompt: string,
  onTextDelta: (delta: string) => void,
): Promise<void> => {
  const configuration = await loadTiaConfiguration();
  if (!configuration) {
    throw new Error(
      "TIA Code has not been configured. Run `tia-code` in an interactive terminal first.",
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
