# TIA Code

[![npm version](https://img.shields.io/npm/v/tia-code.svg)](https://www.npmjs.com/package/tia-code)

> A minimal coding agent to hack with—right in your terminal.

TIA Code turns a plain-language request into useful work in the current project. Ask it to understand a codebase, trace a bug, make a change, run a command, or explain what happened.

It has an interactive terminal experience when you want to collaborate, plus a clean one-shot mode when you want to automate a task.

## See it in action

![TIA Code’s interactive terminal workspace](./screenshot.png)

## What TIA Code can do

- Explore a repository and explain unfamiliar code.
- Investigate bugs and propose or make focused fixes.
- Write, edit, and review code in the current workspace.
- Run project commands and use their results to continue the task.
- Continue saved conversations when work spans more than one session.
- Work with Anthropic, OpenAI, DeepSeek, Kimi, and OpenCode Go models.
- Fit into shell scripts with output that stays on standard output.

## Get started

TIA Code requires Node.js 22.19.0 or later and an API key from one of the providers available during setup.

```sh
npm install -g tia-code
```

Move into the project you want help with, then start TIA Code.

```sh
cd /path/to/your/project
tia-code
```

On first launch, choose a provider and model, then enter its API key. TIA Code stores that configuration locally on your machine.

Now just describe what you need.

```text
Find the source of the slow startup and propose the smallest safe fix.
```

## Set or change your model

Run setup whenever you want to choose a provider, API key, base URL, model, and reasoning effort again. It always opens the setup flow, including when TIA Code is already configured.

```sh
tia-code setup
```

For scripts, CI, or other non-interactive environments, provide a provider, API key, and model ID to save the configuration without opening the terminal UI. `--base-url` optionally overrides a built-in provider endpoint. Custom model IDs are supported.

```sh
tia-code setup \
  --provider opencode-go \
  --api-key "$OPENCODE_API_KEY" \
  --model-id mimo-v2.5 \
  --reasoning-effort high
```

Use `custom` for an OpenAI-compatible endpoint. A base URL is required for custom providers.

```sh
tia-code setup \
  --provider custom \
  --base-url https://llm.example.com/v1 \
  --api-key "$CUSTOM_LLM_API_KEY" \
  --model-id custom-model \
  --reasoning-effort medium
```

Both `setup` and `run` also read these environment variables, which is useful in CI/CD. Explicit command-line options take precedence over environment values.

```sh
export TIA_CODE_PROVIDER=opencode-go
export TIA_CODE_API_KEY="$OPENCODE_API_KEY"
export TIA_CODE_MODEL_ID=mimo-v2.5
export TIA_CODE_BASE_URL=https://opencode.ai/zen/go/v1 # optional for built-in providers
export TIA_CODE_REASONING_EFFORT=high

tia-code setup
```

Available provider IDs are `anthropic`, `openai`, `deepseek`, `kimi`, `opencode-go`, and `custom`. Valid reasoning efforts are `off`, `minimal`, `low`, `medium`, and `high`. The API key is never printed by TIA Code. Prefer an environment variable, as command-line arguments can be retained in shell history or visible to other local processes.

## Work interactively

Use the interactive app for an ongoing conversation about a project. TIA Code keeps the workspace context, can use project skills and connected MCP tools, and shows its progress as it works.

```sh
tia-code
```

Resume a previous interactive session when you want to pick up where you left off.

```sh
tia-code resume <session-id>
```

## Connect MCP tools

TIA Code can connect to the MCP tools you choose. Add a remote server from the command line or from an interactive session. Each add attempts one connection; if an OAuth-capable remote server rejects it, TIA opens the browser sign-in flow once and retries the connection once.

```sh
tia-code mcp add stripe --url https://mcp.stripe.com
```

The command saves the server and OAuth credentials locally, then finishes after its connection check. In an interactive conversation, `/mcp add` also leaves the server connected for that conversation.

```text
/mcp add my-service --url https://service.example/mcp
```

For an SSE endpoint, use `--sse` instead of `--url`. For a local stdio server, supply the command after `--` and name only the environment variables it needs.

```text
/mcp add local-tools --env MY_SERVICE_TOKEN -- node ./my-mcp-server.js
```

On startup, TIA Code reconnects saved MCP servers whose authentication is ready without opening a browser. OAuth sign-ins that are incomplete and servers missing required environment variables stay disconnected until you fix them. Use `/mcp connect <name>` later to connect a saved server or refresh its tool list, `/mcp` to see the full command list, `/mcp logout <name>` to clear local OAuth credentials, and `/mcp remove <name> --confirm` to remove a server. TIA Code stores this list and OAuth credentials only in `~/.tia-code/mcp.json` with owner-only permissions. Bearer-token values stay in your environment; TIA Code stores only their variable names.

## Run one task from a script

Use `run` when you need an answer without opening the terminal UI.

```sh
tia-code run "Summarize the changes in this repository." --reasoning-effort high
```

The connection options on `run` are temporary: they override the saved configuration for only that invocation. This lets a script run against a separate provider without changing local setup.

```sh
tia-code run "Summarize the changes in this repository." \
  --provider custom \
  --base-url https://llm.example.com/v1 \
  --api-key "$CUSTOM_LLM_API_KEY" \
  --model-id custom-model \
  --reasoning-effort high
```

The same `TIA_CODE_PROVIDER`, `TIA_CODE_API_KEY`, `TIA_CODE_MODEL_ID`, `TIA_CODE_BASE_URL`, and `TIA_CODE_REASONING_EFFORT` variables work with `run`; values not overridden use the saved configuration when one is available.

Assistant text is written to standard output. Diagnostics and errors go to standard error, and a failed run exits non-zero.

```sh
review="$(tia-code run 'List the risky files changed in this branch.')"
printf '%s\n' "$review"

tia-code run "Write a release summary for this project." > release-summary.md
```

This makes TIA Code useful in CI helpers, local automation, and any shell workflow where you want a coding agent’s response as text.

## Your workspace, your control

TIA Code uses the directory where you launch it as its workspace. Give it only the repositories you want it to inspect or change, and review requests that may modify files or run commands.

Your provider key is stored locally in `~/.tia-code/config.json` with owner-only permissions. It is not committed to your project or included in the npm package.

Need a separate setup for a disposable environment? Point TIA Code at another local configuration path.

```sh
TIA_CODE_CONFIG_PATH="$PWD/.tia-code-config.json" tia-code
TIA_CODE_CONFIG_PATH="$PWD/.tia-code-config.json" tia-code run "Explain this project."
```

## Open source

TIA Code is maintained by [ZhuXinAI](https://github.com/ZhuXinAI) and released under the [MIT License](./LICENSE).

Source code, issues, and release history live at [github.com/ZhuXinAI/tia-code](https://github.com/ZhuXinAI/tia-code).
