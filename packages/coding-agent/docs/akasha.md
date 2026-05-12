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
