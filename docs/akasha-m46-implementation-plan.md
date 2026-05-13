# Akasha M46 Implementation Plan

## Goal

Add the first Holographic Memory Layer primitive: deterministic, governed memory traces projected from Akasha events.

## Scope

- Add `AkashaMemoryTrace` and `AkashaMemoryTraceKind`.
- Project one event into multiple distributed traces such as semantic, artifact, tool, failure, success, callback, policy, valence, and skill traces.
- Keep the event log as the only fact source. Memory traces are projections and can be rebuilt.
- Reuse the existing projection cache infrastructure instead of adding a new storage system.
- Apply memory governance before trace generation so suppressed/redacted derived facts do not produce active traces.
- Do not inject HML into Action Gate yet; that belongs to M47.

## Files

- Create `packages/coding-agent/src/core/akasha/memory-trace.ts`
- Create `packages/coding-agent/src/core/akasha/memory-trace-cache.ts`
- Create `packages/coding-agent/test/akasha-memory-trace.test.ts`
- Modify `packages/coding-agent/src/core/akasha/index.ts`
- Modify `packages/coding-agent/docs/akasha.md`
- Modify `docs/Akasha_M_Roadmap.md`

## Acceptance

- A failed `tool.completed` event creates semantic, tool, failure, and valence traces.
- A completed callback creates callback, success, and closure traces.
- Trace ids are deterministic across rebuilds.
- Trace projection runs over governed events only.
- Cached traces are fresh on repeated reads and stale/rebuilt after the source event log changes.

## Test Plan

```bash
npm --prefix packages/coding-agent test -- akasha-memory-trace akasha-projection-cache
npm --prefix packages/coding-agent run build
npm run check
```
