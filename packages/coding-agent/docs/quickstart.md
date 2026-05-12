# Quickstart

This page gets you from install to a useful first akasha session.

## Install

Akasha is distributed as an npm package:

```bash
npm install -g @earendil-works/akasha-coding-agent
```

Then start akasha in the project directory you want it to work on:

```bash
cd /path/to/project
akasha
```

## Authenticate

Akasha can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start akasha and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching akasha:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
akasha
```

You can also run `/login` and select an API-key provider to store the key in `~/.akasha/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once akasha starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, akasha gives the model four tools:

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. Akasha runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give akasha project instructions

Akasha loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Akasha loads:

- `~/.akasha/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart akasha, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
akasha @README.md "Summarize this"
akasha @src/app.ts @src/app.test.ts "Review these together"
```

Images can be pasted with Ctrl+V (Alt+V on Windows) or dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
akasha -c                  # Continue most recent session
akasha -r                  # Browse previous sessions
akasha --session <path|id> # Open a specific session
```

Inside akasha, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
akasha -p "Summarize this codebase"
cat README.md | akasha -p "Summarize this text"
akasha -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Akasha](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Akasha Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
