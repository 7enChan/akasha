# Akasha M51: Memory Reconsolidation and Longitudinal Evaluation

## Goal

M51 tightens the first Holographic Memory Layer implementation so recalled memory can safely influence action and action outcomes can influence future recall.

## Tasks

- Use projection cache for HML trace construction in the Temporal Kernel.
- Scope `memory.recalled` to the current turn/correlation so unrelated later tools are not credited to stale recall.
- Project memory feedback from `memory.recalled`, `memory.reinforced`, `memory.weakened`, `memory.decayed`, and `memory.reconsolidated` back into trace weight, confidence, recall count, and last recalled time.
- Add a `memory_recall` runtime policy action before HML memory enters Action Gate context.
- Add kind-specific strict schema checks for memory, sleep replay, and procedure events.
- Split procedure memory into `candidate` and `validated` maturity. Single validation success creates a candidate; repeated success or workflow replay matures it.
- Reduce sleep replay noise by decaying only actionable recalled traces, not generic time/actor traces.
- Add an end-to-end HML behavior test covering replay, recall, application, reinforcement, and improved future trace score.

## Acceptance

- Repeated context builds can reuse trace projection cache.
- A tool call in the same turn as a recall writes `memory.applied`; later unrelated turns do not.
- Reinforced traces score higher on later reconstruction; weakened or decayed traces score lower.
- Strict schema validation rejects malformed HML event payloads.
- Sleep replay only persists validated procedure memories.
