# Akasha M47 Cue Reconstruction Implementation Plan

**Goal:** Turn the M46 trace field into a cue-driven reconstructed memory field that can enter Action Gate context.

**Architecture:** The event log remains the fact source. M47 builds a compact `AkashaMemoryCue` from the current user text, project state, active artifacts, callbacks, failures, policy pressure, and strict protocol gaps, then scores memory traces by resonance instead of plain top-k recency.

**Tasks**
- Add `memory-cue.ts` for current-context cue construction.
- Add `memory-resonance.ts` for multi-signal trace scoring.
- Add `holographic-memory.ts` for field reconstruction and formatting.
- Add a restrained `holographic_memory` section to Action Gate.
- Keep HML optional through `akasha.holographicMemory`.

**Acceptance**
- Active artifacts activate artifact traces.
- Pending callbacks activate callback traces.
- Recent failures activate failure traces.
- Action Gate can show episodes, lessons, procedures, and warnings without replacing temporal facts.

