# Akasha M54: Longitudinal Memory Eval

## Goal

M54 makes Akasha's memory quality measurable across days, sessions, corrections, stale facts, and open loops. The target is not another recall ranking test; it is a compact regression harness that can say whether Akasha remembered the right facts without polluting Action Gate with irrelevant or expired context.

## Scope

- Add a longitudinal eval runner that composes Holographic Memory recall, governance, Temporal Validity, open-loop projection, and Action Gate text checks.
- Add fixture coverage for cross-day coding memory, user corrections, stale health state currentness, and unresolved validation loops.
- Report aggregate metrics for recall hit rate, pollution rate, open-loop coverage, currentness coverage, and Action Gate coverage.

## Non-goals

- No runtime behavior change.
- No new event kinds.
- No database or projection-cache migration.
- No UI or slash command in this slice.

## Acceptance

- A multi-session fixture can require old lessons, stable preferences, active artifacts, and open loops to be recalled together.
- Corrected memories can be required while superseded memories are excluded.
- Stale ephemeral states can be recalled as history while requiring a currentness check.
- Eval failures include actionable diagnostics rather than a single pass/fail flag.
