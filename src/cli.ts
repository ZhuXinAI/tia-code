export type TiaCodeCommand =
  | { type: "interactive"; resumeSessionId?: string }
  | { type: "run"; prompt: string }
  | { type: "help" };

export const TIA_CODE_USAGE = `Usage:
  tia-code
  tia-code resume <session-id>
  tia-code run <prompt>

Commands:
  run <prompt>          Run TIA without the terminal UI; assistant text is written to stdout.
  resume <session-id>   Open a saved session in the terminal UI.
  --help, -h            Show this help.`;

export const parseTiaCodeCommand = (args: readonly string[]): TiaCodeCommand => {
  const commandArgs = args[0] === "--" ? args.slice(1) : args;
  if (commandArgs.length === 0) return { type: "interactive" };

  if (
    commandArgs.length === 1 &&
    (commandArgs[0] === "--help" || commandArgs[0] === "-h" || commandArgs[0] === "help")
  ) {
    return { type: "help" };
  }

  if (commandArgs[0] === "run") {
    const prompt = commandArgs.slice(1).join(" ").trim();
    if (prompt) return { type: "run", prompt };
  }

  if (commandArgs[0] === "resume" && commandArgs.length === 2 && commandArgs[1]?.trim()) {
    return { type: "interactive", resumeSessionId: commandArgs[1].trim() };
  }

  throw new Error(TIA_CODE_USAGE);
};
