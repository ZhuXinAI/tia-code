import { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react-ink";
import { listProjectSkills } from "../agent-skills.js";
import { type McpCommandResult, McpManager } from "../mcp-manager.js";

type SlashCommandId = "model" | "mcp" | "skills";

type SlashCommand = {
  id: SlashCommandId;
  description: string;
};

type CommandPanel = McpCommandResult;

type SlashComposerProps = {
  directory: string;
  mcp: McpManager;
  onConfigure: () => void;
};

const COMMANDS: readonly SlashCommand[] = [
  { id: "model", description: "Choose the TIA provider and model" },
  { id: "mcp", description: "List and manage TIA MCP servers" },
  { id: "skills", description: "List project skills from .agents/skills" },
];

const parseArguments = (value: string): { values?: string[]; error?: string } => {
  const values: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const append = (character: string) => {
    token += character;
  };
  const commit = () => {
    if (token) values.push(token);
    token = "";
  };

  for (const character of value.trim()) {
    if (escaped) {
      append(character);
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else append(character);
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      commit();
      continue;
    }
    append(character);
  }

  if (escaped) append("\\");
  if (quote) return { error: "Close the quoted argument before submitting the command." };
  commit();
  return { values };
};

const findCommand = (input: string): SlashCommand | undefined => {
  const exact = COMMANDS.find((command) => command.id === input);
  if (exact) return exact;
  const matches = COMMANDS.filter((command) => command.id.startsWith(input));
  return matches.length === 1 ? matches[0] : undefined;
};

const Menu = ({ input }: { input: string }) => {
  const query = input.slice(1).toLowerCase();
  const commands = COMMANDS.filter((command) => command.id.startsWith(query));
  if (!input.startsWith("/") || /\s/.test(input)) return null;

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column" marginBottom={1}>
      <Text dimColor>Slash commands</Text>
      {commands.length > 0 ? (
        commands.map((command) => (
          <Text key={command.id}>
            <Text color="cyan">/{command.id}</Text>
            <Text dimColor> · {command.description}</Text>
          </Text>
        ))
      ) : (
        <Text color="yellow">No matching slash command</Text>
      )}
      <Text dimColor>Type a command and press Enter.</Text>
    </Box>
  );
};

const Panel = ({ result }: { result: CommandPanel | undefined }) => {
  if (!result) return null;
  const color = result.tone === "error" ? "red" : result.tone === "success" ? "green" : "cyan";

  return (
    <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column" marginBottom={1}>
      <Text bold color={color}>
        {result.title}
      </Text>
      {result.lines.map((line, index) => (
        <Text key={`${line}-${index}`} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
};

export const SlashComposer = ({ directory, mcp, onConfigure }: SlashComposerProps) => {
  const aui = useAui();
  const text = useAuiState((state) => state.composer.text);
  const [panel, setPanel] = useState<CommandPanel>();
  const [running, setRunning] = useState(false);
  const menuInput = useMemo(() => text.trimStart(), [text]);

  const submitMessage = () => {
    const state = aui.thread().getState();
    if (state.isRunning && !state.capabilities.queue) return;
    void aui.composer().send();
  };

  const submitCommand = (raw: string) => {
    const match = raw.trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
    if (!match) {
      setPanel({
        title: "Slash commands",
        lines: ["Use /model, /mcp, or /skills."],
        tone: "error",
      });
      aui.composer().setText("");
      return;
    }

    const command = findCommand(match[1]!.toLowerCase());
    if (!command) {
      setPanel({
        title: "Slash commands",
        lines: [`Unknown command: /${match[1]}. Use /model, /mcp, or /skills.`],
        tone: "error",
      });
      aui.composer().setText("");
      return;
    }

    const parsed = parseArguments(match[2] ?? "");
    if (parsed.error) {
      setPanel({ title: `/${command.id}`, lines: [parsed.error], tone: "error" });
      return;
    }
    const args = parsed.values ?? [];
    aui.composer().setText("");

    if (command.id === "model") {
      if (args.length > 0) {
        setPanel({ title: "/model", lines: ["Usage: /model"], tone: "error" });
        return;
      }
      onConfigure();
      return;
    }

    if (running) {
      setPanel({ title: `/${command.id}`, lines: ["Another slash command is still running."], tone: "error" });
      return;
    }

    setRunning(true);
    setPanel({ title: `/${command.id}`, lines: ["Working…"], tone: "info" });
    void (async () => {
      try {
        if (command.id === "skills") {
          if (args.length > 0) {
            setPanel({ title: "/skills", lines: ["Usage: /skills"], tone: "error" });
            return;
          }
          const skills = listProjectSkills(directory);
          setPanel({
            title: "Project skills · .agents/skills",
            lines:
              skills.length === 0
                ? ["No project skills were found in .agents/skills."]
                : skills.map(
                    (skill) =>
                      `${skill.name}${skill.description ? ` — ${skill.description}` : ""} (${skill.path})`,
                  ),
            tone: "info",
          });
          return;
        }
        setPanel(await mcp.executeSlashCommand(args));
      } catch (error) {
        setPanel({
          title: `/${command.id}`,
          lines: [error instanceof Error ? error.message : "The command could not complete."],
          tone: "error",
        });
      } finally {
        setRunning(false);
      }
    })();
  };

  return (
    <>
      <Menu input={menuInput} />
      <Panel result={panel} />
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="gray">{"> "}</Text>
        <ComposerPrimitive.Input
          submitOnEnter
          multiLine
          placeholder="Ask TIA to inspect or change this project... (/ for commands)"
          autoFocus
          onSubmit={(value) => {
            if (value.trimStart().startsWith("/")) submitCommand(value);
            else submitMessage();
          }}
        />
      </Box>
    </>
  );
};
