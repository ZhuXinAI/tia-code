import type { SessionStats } from "@earendil-works/pi-coding-agent";

export type PiSessionExitSummary = {
  stats: SessionStats;
  reasoningTokens?: number;
  resumeSessionId?: string;
};

const formatTokens = (value: number): string => value.toLocaleString("en-US");

export const formatPiSessionExitSummary = (
  summary: PiSessionExitSummary | undefined,
): string | undefined => {
  if (!summary || summary.stats.assistantMessages === 0) return undefined;

  const { input, output, cacheRead, cacheWrite } = summary.stats.tokens;
  const cached = cacheRead + cacheWrite;
  // Match Codex's exit display: cache activity is shown separately from the
  // request/response total instead of being folded into the headline number.
  const total = input + output;
  const inputText = `input=${formatTokens(input)}${
    cached > 0 ? ` (+ ${formatTokens(cached)} cached)` : ""
  }`;
  const outputText = `output=${formatTokens(output)}${
    summary.reasoningTokens && summary.reasoningTokens > 0
      ? ` (reasoning ${formatTokens(summary.reasoningTokens)})`
      : ""
  }`;
  const lines = [`Token usage: total=${formatTokens(total)} ${inputText} ${outputText}`];

  if (summary.resumeSessionId) {
    lines.push(
      `To continue this session, run pnpm run dev -- resume ${summary.resumeSessionId}`,
    );
  }

  return lines.join("\n");
};
