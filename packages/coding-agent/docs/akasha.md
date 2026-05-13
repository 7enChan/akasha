# Akasha

Akasha is a time-native coding agent built on the Akasha runtime. It records session, turn, message, tool, artifact, policy, callback, and maintenance events into an append-only JSONL time stream, then projects that stream into temporal recall, action-gate context, task state, and callback lifecycle.

Akasha does not replace the normal session transcript. It writes a sidecar event log and can inject hidden temporal context only when explicitly enabled.

## Quickstart

Initialize Akasha for the current project:

```bash
akasha init
```

This writes the Akasha dogfood preset to `.akasha/settings.json`.

Start the agent through the Akasha entrypoint:

```bash
akasha
```

Check the resolved state:

```bash
akasha status
```

Run daemon maintenance outside an interactive session:

```bash
akasha daemon status --scope project
akasha daemon tick --scope project
akasha daemon run --scope project --dispatch agent_prompt_file
```

Inspect or rebuild projection caches outside a session:

```bash
akasha cache status --scope project
akasha cache rebuild --scope project
akasha cache clear --scope project
```

Inspect callback prompts that were dispatched to the local resume inbox:

```bash
akasha inbox status
akasha inbox list
akasha inbox run --limit 5
akasha inbox consume all
```

Run offline sleep replay consolidation:

```bash
akasha sleep status --scope project
akasha sleep run --scope project
```

Run the Telegram gateway as an always-on IM entrypoint:

```bash
akasha gateway setup
akasha gateway status
akasha gateway
```

Use a global preset instead of a project preset:

```bash
akasha init --global
```

The `akasha` command remains unchanged. `akasha` is the Akasha product entrypoint over the same runtime with Akasha-oriented identity, defaults, and management commands.

## Telegram Gateway

The gateway lets Akasha run as a long-lived Telegram bot while keeping the Time OS event stream as the source of accountability. Telegram input, rejected users, commands, replies, delivery failures, and callback deliveries are written as `gateway.*` events. The normal Akasha session JSONL is still used for conversation continuity.

Configure the non-secret preset:

```bash
akasha gateway setup
```

Add secrets and allowlist values to `~/.akasha/agent/.env`:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USERS=123456789
TELEGRAM_HOME_CHAT=123456789
AKASHA_GATEWAY_DEFAULT_CWD=/path/to/workspace
```

Run in the foreground for a first smoke test:

```bash
akasha gateway status
akasha gateway
```

Gateway callback delivery is controlled by `akasha.gateway.callbackMode`:

- `notify_only` sends a Telegram notification and records dispatch.
- `inbox_only` queues callback prompts into the Akasha inbox.
- `ask_before_run` queues the prompt and tells the home chat to review it before acting.
- `auto_run_safe` queues every prompt, then automatically runs only callbacks marked safe for auto-run, currently promise and prediction due callbacks.

Inside Telegram:

```text
/start
/status
/new
/model [provider/modelId]
/thinking [off|minimal|low|medium|high|xhigh]
/stop
/timeline [n]
/setcwd /path/to/workspace
```

On gateway startup, Akasha registers a compact native Telegram menu with `/new`, `/model`, `/thinking`, `/stop`, and `/timeline`. Other commands remain available by typing them directly.

For Linux always-on deployment, install a user-level systemd service:

```bash
akasha gateway install --user
systemctl --user daemon-reload
akasha gateway start --user
akasha gateway status --user
akasha gateway logs --user
```

The first implementation uses long polling by default. Webhook mode is enabled when `TELEGRAM_WEBHOOK_URL` and `TELEGRAM_WEBHOOK_SECRET` are set; Akasha validates Telegram's `X-Telegram-Bot-Api-Secret-Token` header before accepting webhook updates.

Attachments are stored under:

```text
~/.akasha/agent/gateway/telegram/files/
```

Text documents are appended to the prompt, images are sent as image input, and unsupported files are passed as local file references. If an Akasha response contains `MEDIA:/absolute/path`, the gateway sends that file as Telegram media when it is readable.

## Identity Boundary

Under the `akasha` entrypoint, the agent should identify itself as Akasha. Akasha remains the compatible runtime and implementation lineage, not the user-facing identity.

M27 intentionally keeps these Akasha compatibility surfaces:

- package names such as `@earendil-works/akasha-coding-agent`
- runtime dependencies such as `akasha-ai`, `akasha-agent-core`, and `akasha-tui`
- default settings paths such as `.akasha/settings.json` and `~/.akasha/agent/settings.json`
- the existing `akasha` command

## Dogfood Preset

`akasha init` enables:

- event collection
- temporal brief injection
- action-gate injection
- destructive command enforcement
- maintenance on turn end
- in-process heartbeat maintenance
- secret redaction before event append

It keeps embeddings and reflection disabled by default. Those are useful later, but the default dogfood shell stays local, inspectable, and inexpensive.

`akasha.policyProfile` controls how strongly the runtime policy surface intervenes:

- `observe` records decisions without applying the default blocking rules.
- `dogfood` is the default local safety profile.
- `strict` uses the same default rules with strict temporal-protocol settings when configured.
- `autonomous` adds callback auto-run safety checks for deployments that allow controlled automation.

## Inspecting Time

Inside an Akasha-enabled session, use:

```text
/akasha status
/akasha timeline 30
/akasha action-gate
/akasha queue
/akasha daemon status
/akasha daemon tick
/akasha daemon run
/akasha cache status
/akasha cache rebuild
/akasha cache clear
/akasha sleep status
/akasha sleep run
/akasha task-model
/akasha doctor
/akasha why <eventId|toolCallId>
/akasha callback-complete <callbackId> [evidenceEventId]
/akasha callback-cancel <callbackId> [reason]
```

`/akasha task-model` includes both the legacy typed lists and the graph projection. The graph connects goals, tasks, decisions, risks, artifacts, and callbacks with edges such as `belongs_to`, `blocks`, `tracks`, and `validates`. Edges include source and confidence metadata, so explicit/causal links can be distinguished from temporal or heuristic fallbacks.

`/akasha daemon tick` materializes due callbacks. `/akasha daemon run` claims runnable callbacks, evaluates callback dispatch policy, and records dispatch or failure events. Completion and cancellation remain explicit through `/akasha callback-complete` and `/akasha callback-cancel`.

The shell-level `akasha daemon run` can dispatch callbacks with `agent_prompt_file`, which appends pending callback prompts to:

```text
<agentDir>/akasha/inbox/pending-callbacks.jsonl
```

This gives Akasha a local handoff point for future agent resume flows without requiring a live chat session.

`akasha inbox run` prints actionable callback prompts and records `callback.inbox.injected`. The built-in Akasha context hook also injects actionable inbox items as hidden `<akasha_pending_callbacks>` context on the next model turn and records the same lifecycle event. After the callback has been handled, use `akasha inbox consume <id|all>` to append `callback.inbox.consumed`.

M41 adds automatic resume closure: `akasha_resolve_commitment` and `akasha_check_prediction` accept `callbackId` and `inboxItemId`. When either syscall resolves a pending callback, Akasha appends `time.callback.completed`, `callback.inbox.consumed`, and the inbox status record automatically. Manual `akasha inbox consume` remains available for operator cleanup.

`/akasha doctor` reports event counts, schema issues, retention pressure, and projection cache freshness.

Akasha projections apply governance before injecting hidden context. Suppressed events hide their causal descendants and supported derived facts; redacted source events remain visible only in redacted form, while derived facts sourced from them are omitted from projections.

Artifact validation is scoped. Broad commands such as `npm test` are recorded as validation evidence, but an artifact is marked verified only when the command explicitly references that file path, basename, or stem.

## Time Syscalls

Akasha registers explicit time tools when enabled:

```text
akasha_create_commitment
akasha_resolve_commitment
akasha_create_prediction
akasha_check_prediction
```

These tools write first-class `promise.*` and `prediction.*` events with source metadata. Natural-language extraction remains as a fallback, but assistant responses that call an Akasha syscall tool do not also create duplicate heuristic commitments.

When handling `<akasha_pending_callbacks>`, close the loop through a syscall rather than natural language. Pass the provided `callbackId` or `inboxItemId` to `akasha_resolve_commitment` or `akasha_check_prediction` so the callback and inbox lifecycle can complete automatically.

When the assistant expresses future responsibility without a syscall, Akasha records `time_syscall.missing` in soft audit mode and parents the heuristic fallback commitment/prediction to that audit event. When an assistant response uses a syscall tool, Akasha records a satisfied `time_syscall.audit`.

Set `akasha.temporalProtocol.syscallAuditMode` to `"strict"` to disable heuristic fallback commitment creation. Strict mode keeps the missing-syscall audit open until a later assistant response uses an explicit Akasha syscall, at which point Akasha records `time_syscall.repaired`.

In strict mode, unresolved missing-syscall audits are also injected into the next model context as `<akasha_time_syscall_repair_required>` and recorded as `time_syscall.repair_prompt.injected`. This turns the protocol gap into an auditable repair prompt rather than a passive warning.

## Long-term Memory

Reflection and embeddings remain opt-in. When enabled, reflection runs over governed events, so suppressed/redacted sources do not become long-term crystals. Crystal payloads include `sourceEventIds` for auditability and governance propagation.

Embedding stores support tombstone, purge, and compact operations. Maintenance tombstones embedding targets that fall out of governed projections, so suppressed/redacted event sources do not continue to appear in semantic search results.

M46 adds the first Holographic Memory Layer primitive: memory traces. Traces are deterministic projections from governed events, not a new fact source. A single event can leave semantic, artifact, tool, failure, success, callback, policy, valence, and skill traces. Trace projections are cached under the existing Akasha projection cache and can be deleted or rebuilt from the JSONL event log.

M47-M50 turn traces into a cue-driven memory cortex. The current user text, cwd, active artifacts, pending callbacks, recent failures, policy pressure, and strict protocol gaps form an `AkashaMemoryCue`. Akasha scores traces by resonance, reconstructs a compact memory field, and can inject it into Action Gate as `<akasha_holographic_memory>`. When injected, Akasha writes `memory.recalled`; tool calls following the recall write `memory.applied`, and tool outcomes write `memory.reinforced` or `memory.weakened`.

Sleep replay is the offline consolidation path:

```bash
akasha sleep run --scope project
```

It writes `sleep.replay.started` and `sleep.replay.completed`, then derives repeated failure lessons, callback workflow patterns, procedure candidates, and low-value decay markers. Procedures are derived memories with steps, validation commands, confidence, and `sourceEventIds`; they remain projections over the event log, not a replacement for the original events.

Holographic memory is controlled by:

```json
{
  "akasha": {
    "holographicMemory": {
      "enabled": true,
      "injectIntoActionGate": true,
      "recordRecallEvents": true,
      "maxTraces": 24,
      "maxEpisodes": 3,
      "maxLessons": 3,
      "maxProcedures": 2,
      "maxWarnings": 3
    }
  }
}
```

## Storage

By default, Akasha writes event logs under:

```text
<agentDir>/akasha/events/<sessionId>.jsonl
```

For the default installation this is:

```text
~/.akasha/agent/akasha/events/
```

Projection caches are written under:

```text
<agentDir>/akasha/projections/
```

Projection caches are indexes, not facts. They include source log fingerprints and high-water marks, are invalidated when source logs change, and can be deleted safely because Akasha rebuilds them from JSONL. Project timeline caches track only matching project session logs, and the cache layer supports fast fingerprints plus optional strong SHA-256 fingerprints.

Override with:

```json
{
  "akasha": {
    "eventLogDir": ".akasha/akasha/events"
  }
}
```

## Disable

Set `akasha.enabled` to `false` in the active settings file:

```json
{
  "akasha": {
    "enabled": false
  }
}
```
