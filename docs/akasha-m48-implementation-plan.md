# Akasha M48 Recall Events Implementation Plan

**Goal:** Make recall itself auditable and let later actions reinforce or weaken recalled memory.

**Architecture:** HML reconstruction writes `memory.recalled` when its field is injected. Tool calls following a recall write `memory.applied`; tool outcomes write `memory.reinforced` or `memory.weakened`.

**Tasks**
- Extend the event ontology and strict schema list with recall/reconsolidation events.
- Add `memory-recall-events.ts` for event draft builders.
- Make `action_gate.injected` parent to `memory.recalled`.
- Record simple apply/reinforce/weaken events around tool calls/results.

**Acceptance**
- `/akasha why <action_gate.injected>` can reach `memory.recalled`.
- A tool call after HML context produces `memory.applied`.
- A successful tool result reinforces; a failed result weakens.

