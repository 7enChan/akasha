# Akasha Time OS Closure Plan

> Implementation slice for closing the next three gaps toward "time as the Agent operating system": cross-session project continuity, Karma scheduler callbacks, and temporal recall evaluation.

## Goal

Make Akasha useful beyond a single active session by letting it rebuild project history across sessions, materialize scheduled responsibility checks as events, and regression-test temporal recall quality.

## Scope

### 1. Cross-session Project Timeline

- Build a project-level timeline from all Akasha session logs that share the same `cwd`.
- Preserve original session event logs; project history is a projection, not a new source of truth.
- Expose project history through `/akasha project-timeline [n]`.
- Allow `/akasha project-state project` to rebuild current project state from all matching sessions.
- Order cross-session events by `eventTime`, `recordedTime`, `sessionId`, `sequence`, and `eventId` so duplicate per-session sequence numbers do not corrupt projections.

### 2. Scheduler + Karma Closure

- Extend scheduler derivation beyond "overdue" marking.
- Resolve promises when later evidence satisfies the promise, especially build/test/lint validation promises.
- Check or correct due predictions when later command evidence exists.
- Keep due predictions without evidence as open loops so future turns can surface them.
- Resolve `prediction_due` loops after `prediction.checked` or `prediction.corrected` appears.

### 3. Temporal Recall Eval Harness

- Add a small TypeScript eval harness for recall regression fixtures.
- Eval cases define a query, a limit, `mustInclude`, and `mustExclude` event IDs.
- Use the existing recall policy by default, so ranking changes are testable.
- Add a JSONL fixture that covers failed tools, stale resolved failures, active artifacts, compaction context, and current user intent.

## Tasks

1. Add chronological ordering helpers and use them in projections that must work across sessions.
2. Add `project-timeline.ts` and project-level command output.
3. Enhance scheduler derivation for promise resolution and prediction checking/correction.
4. Add prediction loop resolution support.
5. Add `recall-eval.ts` and JSONL fixture tests.
6. Run focused Akasha tests and the coding-agent build.

## Non-goals

- No database migration; JSONL remains the M-stage source of truth.
- No background daemon outside current maintenance hooks.
- No UI beyond slash commands.
- No cross-device sync.
