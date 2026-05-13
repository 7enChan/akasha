# Akasha M50 Procedural Memory Implementation Plan

**Goal:** Turn repeated successful workflows and validation commands into reusable procedural memories.

**Architecture:** Procedures are derived projections, not facts. They retain `sourceEventIds`, confidence, validation steps, and success/failure counters so HML can inject them as actionable operating knowledge.

**Tasks**
- Add `procedural-memory.ts` and `procedure-policy.ts`.
- Derive validation procedures from successful command events.
- Derive workflow procedures from `workflow.optimized` and `failure.lesson_learned`.
- Feed high-confidence procedures into HML and Action Gate.
- Emit `skill.procedure.*` events during sleep replay.

**Acceptance**
- Successful validation commands form procedure candidates.
- Procedures appear in HML field and Action Gate.
- Sleep replay can persist procedures as `skill.procedure.created`.

