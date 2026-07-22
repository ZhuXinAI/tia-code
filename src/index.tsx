import { render } from "ink";
import { App, type TiaCodeExitResult } from "./app.js";
import { parseTiaCodeCommand } from "./cli.js";
import { formatTiaSessionExitSummary } from "./tia-session-exit.js";

const writeToStdout = (value: string): Promise<void> =>
  new Promise((resolve) => {
    process.stdout.write(value, "utf8", () => resolve());
  });

const main = async (): Promise<void> => {
  let command;
  try {
    command = parseTiaCodeCommand(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const app = render(<App resumeSessionId={command.resumeSessionId} />, {
    exitOnCtrlC: false,
  });
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
