# Akasha M56: Runtime Wiring and Dogfood Gate

## Goal

M56 moves M55 from model seams into runtime evidence. Coding tools and gateway delivery now produce Action Surface audit chains, and Akasha gains a deterministic dogfood gate command for real event logs or explicit corpus specs.

## Architecture

Runtime actions are still executed by the existing coding-agent and gateway paths. M56 adds an audit layer before and after execution:

```text
surface capability -> policy.evaluated -> action_surface.requested -> execution -> action_surface.completed|failed
```

The dogfood gate reuses the M55 longitudinal memory evaluator. It can run against a corpus spec with exact recall expectations, or against the current project event logs as a runtime budget gate.

## Scope

- Wire coding tool calls into the Action Surface audit chain.
- Wire gateway outbox delivery into Action Surface audit, including a Gateway presence heartbeat and idempotency key.
- Add `akasha dogfood gate [--corpus path] [--scope current|project|all]`.
- Add a structured dogfood corpus spec loader.
- Add focused tests for runtime audit and the CLI gate.

## Non-goals

- No new external providers or channels.
- No Docker, SSH, browser, or mobile execution surface.
- No broad replacement of existing Tool Gate logic.
- No real model calls in the dogfood gate.

## Acceptance

- A normal coding tool call writes `policy.evaluated`, `action_surface.requested`, `tool.requested`, `tool.completed`, and `action_surface.completed`.
- A blocked tool writes `action_surface.failed`.
- Gateway delivery writes Gateway presence, surface policy, requested, and completed/failed action surface events.
- `akasha dogfood gate --corpus <path>` reports a pass/fail result and sets a failing exit code on regressions.
- Focused tests and `npm run check` pass.
