# Akasha M40 Implementation Plan

## Goal

Close the first resume loop for Akasha callbacks: daemon-dispatched callback prompts become an auditable inbox, the next Akasha run can inject them into action context, and operators can inspect or consume them explicitly.

## Scope

- Add an append-only callback inbox lifecycle over `pending-callbacks.jsonl`.
- Add first-class `akasha inbox` CLI commands.
- Inject pending inbox items through the built-in Akasha context hook.
- Add strict temporal syscall protocol settings and repair tracking.
- Add the first OS-level policy rules for context injection, callback dispatch, embedding indexing, export, and syscall creation.

## Implementation Tasks

1. Extend the event ontology with `callback.inbox.added`, `callback.inbox.injected`, `callback.inbox.consumed`, `callback.inbox.failed`, and `callback.inbox.cancelled`.
2. Refactor `callback-inbox.ts` so the inbox stores prompt records plus append-only status records and exposes a projection of actionable items.
3. Make `agent_prompt_file` dispatch write `callback.inbox.added` into the event stream.
4. Add `akasha inbox status|list|run|consume` to the top-level CLI.
5. Inject pending callbacks in the collector `context` hook as hidden custom context and record `callback.inbox.injected`.
6. Add `akasha.temporalProtocol.syscallAuditMode` with `soft` default and strict-mode repair events.
7. Expand the runtime policy kernel with concrete OS-level rules and wire the rules into context injection, callback dispatch, and embedding maintenance.
8. Update docs and tests for inbox lifecycle, CLI, syscall audit, policy rules, and context injection.

## Verification

- `npm --prefix packages/coding-agent test -- akasha-callback-dispatcher akasha-entry-cli akasha-time-syscall-audit akasha-runtime-policy akasha-extension`
- `npm --prefix packages/coding-agent run build`
- `npm run check`
