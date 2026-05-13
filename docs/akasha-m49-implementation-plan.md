# Akasha M49 Sleep Replay Implementation Plan

**Goal:** Add a lightweight sleep replay worker that consolidates repeated failures, callback closures, and procedure candidates offline.

**Architecture:** Sleep replay is a maintenance-style pass over governed events. It writes started/completed lifecycle events and append-only derived memories with deterministic source keys.

**Tasks**
- Add `sleep-replay.ts`.
- Add `akasha sleep status|run` and `/akasha sleep status|run`.
- Derive repeated failure lessons, callback workflow optimizations, procedure candidates, and low-value decay markers.
- Keep replay deterministic and idempotent by source key.

**Acceptance**
- Repeated failures produce `failure.lesson_learned`.
- Completed callbacks can produce `workflow.optimized`.
- Procedure candidates become `skill.procedure.created`.
- Replay emits `sleep.replay.started` and `sleep.replay.completed`.

