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
/akasha task-model
/akasha why <eventId|toolCallId>
/akasha callback-complete <callbackId> [evidenceEventId]
/akasha callback-cancel <callbackId> [reason]
```

`/akasha task-model` includes both the legacy typed lists and the M15 graph projection. The graph connects goals, tasks, decisions, risks, artifacts, and callbacks with edges such as `belongs_to`, `blocks`, `tracks`, and `validates`.

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

## Long-term Memory

Reflection and embeddings remain opt-in. When enabled, reflection runs over governed events, so suppressed/redacted sources do not become long-term crystals. Crystal payloads include `sourceEventIds` for auditability and governance propagation.

## Storage

By default, Akasha writes event logs under:

```text
<agentDir>/akasha/events/<sessionId>.jsonl
```

For the default installation this is:

```text
~/.pi/agent/akasha/events/
```

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
