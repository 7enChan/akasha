# Akasha M21-M25 Implementation Plan

**Goal:** Move Akasha from a Time OS prototype toward an operational temporal runtime with cached projections, executable callbacks, a broader policy surface, syscall auditing, and causal task graph edges.

**Architecture:** JSONL remains the only source of truth. New projection caches are durable, versioned, and rebuildable indexes keyed by source log fingerprints. Callback execution is represented as an auditable lifecycle in the event stream. Policy, syscall audit, and graph improvements attach to existing kernel and collector seams instead of introducing a second runtime.

**Tech Stack:** TypeScript, Vitest, append-only JSONL, local filesystem cache files.

---

## M21: Projection Cache and Compaction Boundary

**Files**
- Create `packages/coding-agent/src/core/akasha/projection-cache.ts`
- Modify `packages/coding-agent/src/core/akasha/temporal-kernel.ts`
- Modify `packages/coding-agent/src/core/akasha/project-timeline.ts`
- Modify `packages/coding-agent/src/core/akasha/user-timeline.ts`
- Modify `packages/coding-agent/src/core/akasha/doctor.ts`
- Modify `packages/coding-agent/src/core/akasha/commands.ts`
- Add `packages/coding-agent/test/akasha-projection-cache.test.ts`

**Tasks**
- Add cache metadata with projection version, source log paths, source file fingerprints, event high-water marks, and created/updated timestamps.
- Cache session temporal state snapshots used by `AkashaTemporalKernel.buildState()`.
- Cache project and user timeline projections while keeping event logs as the rebuildable fact source.
- Extend `/akasha doctor` to report cache path and freshness.
- Verify cache deletion causes a clean rebuild and source log append invalidates stale cache.

## M22: Callback Runner

**Files**
- Create `packages/coding-agent/src/core/akasha/callback-runner.ts`
- Modify `packages/coding-agent/src/core/akasha/types.ts`
- Modify `packages/coding-agent/src/core/akasha/schema.ts`
- Modify `packages/coding-agent/src/core/akasha/daemon-queue.ts`
- Modify `packages/coding-agent/src/core/akasha/temporal-kernel.ts`
- Modify `packages/coding-agent/src/core/akasha/commands.ts`
- Add `packages/coding-agent/test/akasha-callback-runner.test.ts`

**Tasks**
- Add `time.callback.claimed`, `time.callback.dispatched`, and `time.callback.failed`.
- Implement `runAkashaCallbackRunner()` that ticks the daemon queue, claims due callbacks, evaluates dispatch policy, and records dispatch or failure.
- Add `/akasha daemon status`, `/akasha daemon tick`, and `/akasha daemon run`.
- Keep completion/cancellation explicit via existing lifecycle commands.

## M23: Universal Policy Surface

**Files**
- Modify `packages/coding-agent/src/core/akasha/policy-kernel.ts`
- Modify `packages/coding-agent/src/core/akasha/temporal-kernel.ts`
- Modify `packages/coding-agent/src/core/akasha/callback-runner.ts`
- Add `packages/coding-agent/test/akasha-runtime-policy.test.ts`

**Tasks**
- Add typed runtime actions for `tool_call`, `context_injection`, `temporal_recall`, `callback_dispatch`, `reflection`, `embedding_index`, `memory_projection`, `export`, and `syscall`.
- Add a generic runtime policy evaluator and append auditable `policy.evaluated` events for non-tool critical actions.
- Apply callback dispatch policy inside the runner and context injection policy inside the kernel.

## M24: Syscall Audit Mode

**Files**
- Create `packages/coding-agent/src/core/akasha/time-syscall-audit.ts`
- Modify `packages/coding-agent/src/core/akasha/types.ts`
- Modify `packages/coding-agent/src/core/akasha/schema.ts`
- Modify `packages/coding-agent/src/core/akasha/collector-extension.ts`
- Add `packages/coding-agent/test/akasha-time-syscall-audit.test.ts`

**Tasks**
- Add `time_syscall.audit`, `time_syscall.missing`, and `time_syscall.repaired`.
- When an assistant message contains future responsibility but no Akasha syscall, record `time_syscall.missing` in soft mode and parent heuristic fallback events to that audit.
- When an assistant message does use a syscall, record `time_syscall.audit` with status `satisfied`.

## M25: Causal Task Graph

**Files**
- Modify `packages/coding-agent/src/core/akasha/task-model.ts`
- Modify `packages/coding-agent/src/core/akasha/commands.ts`
- Add or extend `packages/coding-agent/test/akasha-task-model.test.ts`

**Tasks**
- Add edge metadata: `source`, `confidence`, and `sourceEventIds`.
- Prefer explicit and causal links from `parentEventIds`, `targetEventId`, `sourceEventIds`, `evidenceEventIds`, `resolverEventId`, and `toolCallId`.
- Keep existing temporal and text-reference edges as lower-confidence fallbacks.
- Show edge source/confidence in `/akasha task-model`.

## Validation

- `npm --prefix packages/coding-agent test -- akasha-projection-cache akasha-callback-runner akasha-runtime-policy akasha-time-syscall-audit akasha-task-model akasha-temporal-kernel akasha-daemon-queue akasha-extension`
- `npm --prefix packages/coding-agent test -- akasha`
- `npm --prefix packages/coding-agent test -- agent-session extensions session-manager settings-manager`
- `npm --prefix packages/coding-agent run build`
- `npm run check`
