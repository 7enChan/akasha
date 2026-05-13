# Akasha M43 Implementation Plan

## Goal

Turn strict temporal syscall mode from passive audit into an auditable repair loop.

## Scope

- Add `time_syscall.repair_prompt.injected` to the event ontology.
- When strict mode has unrepaired `time_syscall.missing` events, inject a stronger hidden repair context.
- Record the repair prompt injection as an event parented to the missing audits.
- Keep `time_syscall.repaired` as the closure event when a later explicit syscall appears.

## Verification

- Extension tests cover strict missing syscall, repair prompt injection, and repair event closure.
