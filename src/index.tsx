#!/usr/bin/env node

import type { TiaCodeExitResult } from "./app.js";
import {
  parseTiaCodeCommand,
  TIA_CODE_USAGE,
  type TiaSetupConfiguration,
} from "./cli.js";
import { McpManager } from "./mcp-manager.js";
import { runTiaCodePrompt } from "./non-interactive.js";
import {
  getTiaProviderOption,
  saveTiaConfiguration,
  type TiaConfigurationOverrides,
} from "./tia-configuration.js";
import { formatTiaSessionExitSummary } from "./tia-session-exit.js";

const writeToStdout = (value: string): Promise<void> =>
  new Promise((resolve) => {
    process.stdout.write(value, "utf8", () => resolve());
  });

const writeToStderr = (value: string): Promise<void> =>
  new Promise((resolve) => {
    process.stderr.write(value, "utf8", () => resolve());
  });

const runNonInteractive = async (
  prompt: string,
  configuration: TiaConfigurationOverrides | undefined,
): Promise<void> => {
  let pendingOutput = Promise.resolve();
  let wroteOutput = false;
  let endsWithNewline = false;
  const enqueueOutput = (value: string): void => {
    if (value) {
      wroteOutput = true;
      endsWithNewline = value.endsWith("\n");
    }
    pendingOutput = pendingOutput.then(() => writeToStdout(value));
  };

  try {
    await runTiaCodePrompt(prompt, enqueueOutput, configuration);
  } finally {
    if (wroteOutput && !endsWithNewline) enqueueOutput("\n");
    await pendingOutput;
  }
};

const runMcpCommand = async (args: readonly string[]): Promise<void> => {
  const mcp = new McpManager();
  try {
    const result = await mcp.executeSlashCommand(args);
    const output = `${result.title}\n${result.lines.join("\n")}\n`;
    if (result.tone === "error") {
      await writeToStderr(output);
      process.exitCode = 1;
      return;
    }
    await writeToStdout(output);
  } catch (error) {
    await writeToStderr(`TIA Code MCP failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await mcp.dispose();
  }
};

const runSetup = async (setup: TiaSetupConfiguration): Promise<void> => {
  const configuration = await saveTiaConfiguration({ version: 1, ...setup });
  const provider = getTiaProviderOption(configuration.providerId);
  await writeToStdout(
    `TIA Code is configured for ${provider.label} · ${configuration.modelId} · ${configuration.reasoningEffort}.\n`,
  );
};

const main = async (): Promise<void> => {
  let command;
  try {
    command = parseTiaCodeCommand(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  if (command.type === "help") {
    await writeToStdout(`${TIA_CODE_USAGE}\n`);
    return;
  }

  if (command.type === "run") {
    try {
      await runNonInteractive(command.prompt, command.configuration);
    } catch (error) {
      process.stderr.write(
        `TIA Code run failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (command.type === "mcp") {
    await runMcpCommand(command.args);
    return;
  }

  if (command.type === "setup" && command.configuration) {
    try {
      await runSetup(command.configuration);
    } catch (error) {
      process.stderr.write(
        `TIA Code setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  const [{ render }, { App }] = await Promise.all([import("ink"), import("./app.js")]);

  const app = render(
    <App
      resumeSessionId={command.type === "interactive" ? command.resumeSessionId : undefined}
      startInSetup={command.type === "setup"}
    />,
    {
      exitOnCtrlC: false,
    },
  );
  try {
    const result = (await app.waitUntilExit()) as TiaCodeExitResult | undefined;
    const summary = formatTiaSessionExitSummary(result?.session);
    if (summary) await writeToStdout(`\n${summary}\n`);
    if (result?.error) {
      process.stderr.write(`TIA Code shutdown error: ${result.error}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`TIA Code exited unexpectedly: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
};

await main();
// The embedded model runtime can retain benign process handles after its session has
// been disposed. Ink has already restored the terminal and the final usage
// output has flushed, so exit explicitly instead of leaving the TUI open.
process.exit(process.exitCode ?? 0);
