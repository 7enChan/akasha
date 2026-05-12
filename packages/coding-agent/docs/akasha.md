# Akasha

Akasha is the optional local-first time layer for coding-agent sessions. It records session, turn, message, tool, artifact, policy, callback, and maintenance events into an append-only JSONL time stream, then projects that stream into temporal recall, action-gate context, task state, and callback lifecycle.

Akasha does not replace the normal session transcript. It writes a sidecar event log and can inject hidden temporal context only when explicitly enabled.

## Quickstart

Initialize Akasha for the current project:

```bash
akasha init
```

This writes the Akasha dogfood preset to `.pi/settings.json`.

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

Use a global preset instead of a project preset:

```bash
akasha init --global
```

The `pi` command remains unchanged. `akasha` is an alias entrypoint over the same runtime with Akasha-oriented defaults and management commands.

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

When the assistant expresses future responsibility without a syscall, Akasha records `time_syscall.missing` in soft audit mode and parents the heuristic fallback commitment/prediction to that audit event. When an assistant response uses a syscall tool, Akasha records a satisfied `time_syscall.audit`.

## Long-term Memory

Reflection and embeddings remain opt-in. When enabled, reflection runs over governed events, so suppressed/redacted sources do not become long-term crystals. Crystal payloads include `sourceEventIds` for auditability and governance propagation.

Embedding stores support tombstone, purge, and compact operations. Maintenance tombstones embedding targets that fall out of governed projections, so suppressed/redacted event sources do not continue to appear in semantic search results.

## Storage

By default, Akasha writes event logs under:

```text
<agentDir>/akasha/events/<sessionId>.jsonl
```

For the default installation this is:

```text
~/.pi/agent/akasha/events/
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
    "eventLogDir": ".pi/akasha/events"
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
