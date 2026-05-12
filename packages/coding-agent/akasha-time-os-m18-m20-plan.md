# Akasha M18-M20 Implementation Plan

**Goal:** Move Akasha beyond heuristic memory extraction by adding explicit time syscalls, regression fixtures for temporal behavior, and stronger reflection/crystal/RAG handling.

## M18: Explicit Time Syscalls

- Add internal syscall helpers for creating/resolving commitments and creating/checking predictions.
- Register LLM-callable Akasha tools:
  - `akasha_create_commitment`
  - `akasha_resolve_commitment`
  - `akasha_create_prediction`
  - `akasha_check_prediction`
- Syscall events should write first-class `promise.*` and `prediction.*` events with `source: "syscall"`, confidence, criteria, source event ids, and tool call correlation.
- Heuristic extraction remains as fallback but is suppressed when an assistant response already calls an explicit Akasha syscall tool.

## M19: Temporal Behavior Eval Fixtures

- Add behavior-level evals that validate projected state, not just recall ranking.
- Cover commitments, action-gate inclusion, governed suppression, task graph edges, and scoped artifact verification.
- Store fixtures under `test/fixtures/akasha/` so future runtime changes can be regression-tested.

## M20+: Reflection Crystals and Temporal RAG Hardening

- Run reflection on governed events so suppressed/redacted sources do not become long-term crystals.
- Add explicit `sourceEventIds` to crystal payloads and memory crystal payloads.
- Improve embedding text extraction for crystal statements, predictions, corrections, and resolution criteria.
- Keep reflection local and opt-in; this phase hardens the pipeline without enabling expensive reflection by default.

## Validation

```bash
npm --prefix packages/coding-agent test -- akasha-accountability akasha-time-syscalls akasha-temporal-behavior-eval akasha-reflection-worker akasha-embedding akasha-extension
npm --prefix packages/coding-agent test -- akasha
npm --prefix packages/coding-agent run build
npm run check
```
