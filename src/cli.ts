export type TiaCodeCommand = {
  resumeSessionId?: string;
};

const usage = "Usage: tia-code [resume <session-id>]";

export const parseTiaCodeCommand = (args: readonly string[]): TiaCodeCommand => {
  const commandArgs = args[0] === "--" ? args.slice(1) : args;
  if (commandArgs.length === 0) return {};

  if (commandArgs[0] === "resume" && commandArgs.length === 2 && commandArgs[1]?.trim()) {
    return { resumeSessionId: commandArgs[1].trim() };
  }

  throw new Error(usage);
};
