# Settings

Akasha uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.akasha/agent/settings.json` | Global (all projects) |
| `.akasha/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `false` | Send an anonymous install/update version ping after first install or changelog-detected updates, only when an Akasha telemetry endpoint is explicitly configured |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |

### Telemetry and update checks

`enableInstallTelemetry` only controls the anonymous install/update ping. Telemetry is disabled by default and requires an explicit Akasha telemetry endpoint before any install/update ping is sent. Opting out of telemetry does not disable update checks; Akasha checks GitHub releases for new versions unless version checks are disabled.

Set `AKASHA_SKIP_VERSION_CHECK=1` to disable the Akasha version update check. Use `--offline` or `AKASHA_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Akasha Time Bus

Akasha is an optional local sidecar memory layer for coding-agent session and tool lifecycles. When enabled, it writes append-only JSONL event logs without changing the normal session transcript.

Use the Akasha entrypoint to write the recommended local-first preset:

```bash
akasha init
```

Use `akasha init --global` to write the preset to global settings instead of the current project.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `akasha.enabled` | boolean | `false` | Enable the built-in Akasha collector and `/akasha` command |
| `akasha.injectTemporalBrief` | boolean | `false` | Inject a compact temporal brief into LLM context without persisting it to the session transcript |
| `akasha.maxBriefEvents` | number | `12` | Maximum event count considered for the injected temporal brief |
| `akasha.eventLogDir` | string | - | Override event log directory; defaults to `<agentDir>/akasha/events` |
| `akasha.actionGate.enabled` | boolean | `false` | Inject a compact pre-action control brief into LLM context without persisting it to the transcript |
| `akasha.actionGate.includeProjectState` | boolean | `true` | Include cross-session project state in the action gate |
| `akasha.actionGate.includeUserTimeline` | boolean | `true` | Include user-level preferences, commitments, and corrections in the action gate |
| `akasha.actionGate.maxItems` | number | `8` | Maximum items per action-gate section |
| `akasha.actionGate.enforceToolGate` | boolean | `false` | Enable hard pre-tool-call enforcement from Akasha |
| `akasha.actionGate.blockDestructiveCommands` | boolean | `true` | When tool enforcement is enabled, block high-risk destructive shell commands |
| `akasha.actionGate.blockUnverifiedArtifactWrites` | boolean | `false` | When tool enforcement is enabled, block editing additional artifacts while previous modifications remain unverified |
| `akasha.embedding.enabled` | boolean | `false` | Enable semantic temporal recall indexing |
| `akasha.embedding.provider` | string | `"off"` | Embedding provider: `"off"`, `"hash"`, or `"openai-compatible"` |
| `akasha.embedding.indexDir` | string | - | Override embedding index directory; defaults to `<agentDir>/akasha/embeddings` |
| `akasha.embedding.model` | string | `"text-embedding-3-small"` | Model name for OpenAI-compatible embedding endpoints |
| `akasha.embedding.baseUrl` | string | `"https://api.openai.com/v1/embeddings"` | OpenAI-compatible embeddings endpoint |
| `akasha.embedding.apiKeyEnv` | string | `"OPENAI_API_KEY"` | Environment variable used for the embedding API key |
| `akasha.reflection.enabled` | boolean | `false` | Enable automatic reflection during Akasha maintenance |
| `akasha.maintenance.enabled` | boolean | `false` | Enable Akasha maintenance pass support |
| `akasha.maintenance.runOnTurnEnd` | boolean | `false` | Run maintenance at turn end when enabled |
| `akasha.maintenance.heartbeatEnabled` | boolean | `false` | Run maintenance from an in-process wall-clock heartbeat while the session is active |
| `akasha.maintenance.heartbeatIntervalMinutes` | number | `30` | Heartbeat maintenance interval in minutes |
| `akasha.maintenance.runOnSessionStart` | boolean | `false` | Run one maintenance pass immediately after the session starts |
| `akasha.privacy.redactSecrets` | boolean | `true` | Redact common secrets before appending Akasha events |
| `akasha.temporalProtocol.syscallAuditMode` | string | `"soft"` | `"soft"` records missing syscalls plus heuristic fallback events; `"strict"` records missing syscalls without fallback events until an explicit syscall repairs the protocol gap |
| `akasha.holographicMemory.enabled` | boolean | `false` | Enable cue-driven holographic memory reconstruction |
| `akasha.holographicMemory.injectIntoActionGate` | boolean | `false` | Inject reconstructed memory field into Action Gate context |
| `akasha.holographicMemory.recordRecallEvents` | boolean | `true` | Record `memory.recalled` when HML enters Action Gate |
| `akasha.holographicMemory.maxTraces` | number | `24` | Maximum traces scored into one reconstructed memory field |
| `akasha.holographicMemory.maxEpisodes` | number | `3` | Maximum reconstructed episodes injected into Action Gate |
| `akasha.holographicMemory.maxLessons` | number | `3` | Maximum lessons injected into Action Gate |
| `akasha.holographicMemory.maxProcedures` | number | `2` | Maximum procedural memories injected into Action Gate |
| `akasha.holographicMemory.maxWarnings` | number | `3` | Maximum memory warnings injected into Action Gate |
| `akasha.policyProfile` | string | `"dogfood"` | Runtime policy profile: `"observe"`, `"dogfood"`, `"strict"`, or `"autonomous"` |
| `akasha.gateway.enabled` | boolean | `false` | Enable the long-running IM gateway runtime |
| `akasha.gateway.defaultCwd` | string | current cwd | Default workspace used by gateway chats |
| `akasha.gateway.callbackMode` | string | `"notify_only"` | Gateway callback delivery: `"notify_only"`, `"inbox_only"`, `"ask_before_run"`, or `"auto_run_safe"` |
| `akasha.gateway.platforms.telegram.enabled` | boolean | `false` | Enable the Telegram adapter |
| `akasha.gateway.platforms.telegram.mode` | string | `"polling"` | Telegram mode: `"polling"` or `"webhook"` |
| `akasha.gateway.platforms.telegram.botTokenEnv` | string | `"TELEGRAM_BOT_TOKEN"` | Environment variable that stores the Telegram bot token |
| `akasha.gateway.platforms.telegram.allowedUsersEnv` | string | `"TELEGRAM_ALLOWED_USERS"` | Comma-separated Telegram user allowlist environment variable |
| `akasha.gateway.platforms.telegram.homeChatEnv` | string | `"TELEGRAM_HOME_CHAT"` | Chat that receives daemon callback notifications |

Useful inspection commands include `/akasha timeline [n]` for the current session, `/akasha project-timeline [n]` for all sessions in the current project `cwd`, `/akasha user-timeline` for user-level memory, `/akasha action-gate` for the pre-action control brief, `/akasha states` or `/akasha validity` for ephemeral state currentness, `/akasha queue` for due callbacks, `/akasha sleep status|run` for offline memory replay, `/akasha callback-complete <callbackId> [evidenceEventId]` and `/akasha callback-cancel <callbackId> [reason]` for callback lifecycle, `/akasha maintain [session|project|all]` for detached maintenance, `/akasha memory-review` plus `/akasha memory-pin|memory-unpin|memory-suppress <eventId>` for memory governance, `/akasha redact <eventId> <field> [reason]` for append-only redaction, `/akasha project-state project` for cross-session project state, `/akasha scheduler` for a manual Karma/scheduler pass, and `/akasha doctor` for schema, redaction, and retention diagnostics.

Callback resume closure is syscall-driven. `akasha_resolve_commitment` and `akasha_check_prediction` both accept optional `callbackId` and `inboxItemId`; when supplied, Akasha automatically appends `time.callback.completed` and `callback.inbox.consumed`. In strict syscall audit mode, Akasha injects unresolved missing-syscall audits into the next model context as an auditable repair prompt.

```json
{
  "akasha": {
    "enabled": true,
    "injectTemporalBrief": true,
    "maxBriefEvents": 12,
    "actionGate": {
      "enabled": true,
      "enforceToolGate": true
    },
    "embedding": {
      "enabled": true,
      "provider": "openai-compatible"
    },
    "maintenance": {
      "enabled": true,
      "heartbeatEnabled": true,
      "heartbeatIntervalMinutes": 30
    },
    "temporalProtocol": {
      "syscallAuditMode": "soft"
    },
    "holographicMemory": {
      "enabled": true,
      "injectIntoActionGate": true,
      "recordRecallEvents": true
    },
    "policyProfile": "dogfood",
    "gateway": {
      "enabled": true,
      "defaultCwd": "/path/to/workspace",
      "callbackMode": "notify_only",
      "platforms": {
        "telegram": {
          "enabled": true,
          "mode": "polling",
          "botTokenEnv": "TELEGRAM_BOT_TOKEN",
          "allowedUsersEnv": "TELEGRAM_ALLOWED_USERS",
          "homeChatEnv": "TELEGRAM_HOME_CHAT"
        }
      }
    }
  }
}
```

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | SDK default | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"sse"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, or `"auto"` |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

Normally the package manager's global modules location is queried using `root -g`. As a special case, if the first element of `npmCommand` is `"bun"`, the modules location will instead be queried with `pm bin -g`.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".akasha/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `AKASHA_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.akasha/agent/settings.json` resolve relative to `~/.akasha/agent`. Paths in `.akasha/settings.json` resolve relative to `.akasha`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["akasha-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "akasha-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["akasha-skills"]
}
```

## Project Overrides

Project settings (`.akasha/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.akasha/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .akasha/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
