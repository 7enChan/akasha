# Akasha M15-M17 Implementation Plan

**Goal:** Advance Akasha from typed state lists toward a more reliable Time OS state layer by adding task graph relationships, governance propagation, and scoped artifact validation.

## M15: Temporal Task Graph

- Extend `AkashaTaskModel` with a `graph` projection while preserving the existing `goals`, `tasks`, `decisions`, and `risks` lists.
- Graph nodes include goals, tasks, decisions, risks, artifacts, and callbacks.
- Graph edges include `belongs_to`, `blocks`, `caused_by`, `validates`, `tracks`, and `references`.
- `/akasha task-model` should show a compact graph summary so task, risk, artifact, and callback relationships are inspectable.

## M16: Governance Propagation

- Upgrade memory governance suppression from a direct target filter into a closure over causal descendants and declared support/source event ids.
- Derived facts such as preferences, crystals, promises, summaries, and action-gate facts should disappear from projections when their source event is suppressed.
- Keep governance append-only: no historical rewrite, only projection-level filtering.
- Apply governed filtering to user timeline and temporal briefs so hidden context does not continue using suppressed facts.

## M17: Artifact Verification Integrity

- Replace broad "any successful validation validates all modified files" behavior with scoped validation inference.
- A validation command verifies an artifact only when the command explicitly names the path, basename, or stem for that artifact.
- Broad project validation is recorded as observed evidence but does not automatically mark every modified artifact as verified.
- Open loops and task risks should remain active until scoped validation covers the relevant artifact.

## Validation

- Add or update focused tests for task graph edges, suppression closure, brief filtering, scoped artifact validation, and open-loop resolution.
- Run:

```bash
npm --prefix packages/coding-agent test -- akasha-task-model akasha-memory-governance akasha-sensitive-data akasha-world-model akasha-temporal-state akasha-open-loops
npm --prefix packages/coding-agent test -- akasha
npm --prefix packages/coding-agent run build
npm run check
```
