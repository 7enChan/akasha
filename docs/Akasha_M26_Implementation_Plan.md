# Akasha M26 Implementation Plan

**Goal:** Turn Akasha's local time runtime into a more independent time operator by adding real callback dispatchers, shell-level daemon/cache commands, cache hardening, and embedding index governance.

**Architecture:** Keep JSONL event logs as the fact source. Callback dispatchers produce auditable event payloads and optional local side effects, with `agent_prompt_file` writing a pending inbox that future agent startup paths can consume. CLI daemon/cache commands run outside an interactive session through the Akasha entrypoint. Projection caches remain rebuildable indexes. Embedding governance adds tombstone/purge/compact operations so long-term vector records obey suppression/redaction boundaries.

**Tech Stack:** TypeScript, Vitest, local JSONL files, filesystem cache/index artifacts.

---

## M26.1 Real Callback Dispatchers

**Files**
- Modify `packages/coding-agent/src/core/akasha/callback-runner.ts`
- Create `packages/coding-agent/src/core/akasha/callback-inbox.ts`
- Add `packages/coding-agent/test/akasha-callback-dispatcher.test.ts`

**Tasks**
- Add `AkashaCallbackDispatcher` and `AkashaCallbackDispatchResult`.
- Implement dispatch modes:
  - `record_only`: no side effect, records dispatch payload.
  - `terminal_notification`: records a terminal-readable notification message.
  - `agent_prompt_file`: appends a pending prompt item to `<agentDir>/akasha/inbox/pending-callbacks.jsonl`.
- Include dispatcher output in `time.callback.dispatched` or `time.callback.failed`.
- Keep runner idempotency: already dispatched/failed/completed/cancelled callbacks are terminal.

## M26.2 CLI Daemon Outside Session

**Files**
- Modify `packages/coding-agent/src/akasha-entry-cli.ts`
- Add `packages/coding-agent/test/akasha-entry-cli.test.ts` coverage

**Tasks**
- Add `akasha daemon status|tick|run`.
- Support `--scope current|project|all`; `current` aliases project cwd for now.
- Support `--dispatch record_only|terminal_notification|agent_prompt_file`.
- Use resolved Akasha settings, event log dir, and reflection settings without creating an AgentSession.

## M26.3 Projection Cache Hardening

**Files**
- Modify `packages/coding-agent/src/core/akasha/projection-cache.ts`
- Modify `packages/coding-agent/src/core/akasha/project-timeline.ts`
- Modify `packages/coding-agent/src/core/akasha/commands.ts`
- Add `packages/coding-agent/test/akasha-projection-cache.test.ts` coverage

**Tasks**
- Add optional strong source fingerprint mode using SHA-256 content hash.
- Narrow project timeline cache source logs to sessions matching the current cwd.
- Add cache utilities: status, clear, rebuild.
- Add `/akasha cache status|clear|rebuild`.

## M26.4 Embedding Tombstone / Purge / Compact

**Files**
- Modify `packages/coding-agent/src/core/akasha/embedding-store.ts`
- Modify `packages/coding-agent/src/core/akasha/maintenance.ts`
- Add `packages/coding-agent/test/akasha-embedding.test.ts` coverage

**Tasks**
- Add tombstone records for embedding ids and target ids.
- Ensure `has`, `list`, and `search` ignore tombstoned records.
- Add `purge` and `compact` to physically remove tombstoned records from JSONL stores.
- During maintenance, project governed events and tombstone embeddings whose event targets are no longer governed.

## Validation

- `npm --prefix packages/coding-agent test -- akasha-callback-dispatcher akasha-entry-cli akasha-projection-cache akasha-embedding akasha-callback-runner akasha-maintenance`
- `npm --prefix packages/coding-agent test -- akasha`
- `npm --prefix packages/coding-agent test -- agent-session extensions session-manager settings-manager`
- `npm --prefix packages/coding-agent run build`
- `npm run check`
