# Akasha M52: Reconsolidation Detector and Procedure Feedback

## Goal

M52 closes the next Holographic Memory Layer loop: user corrections and governance changes can reconsolidate recalled memory, procedures receive outcome feedback, and memory recall policy records real governance evidence.

## Tasks

- Add a reconsolidation detector that derives `memory.reconsolidated` from user corrections, prediction corrections, and suppression/redaction events that affect previously recalled memory.
- Connect the detector to the collector so normal message and tool lifecycles can append reconsolidation events idempotently.
- Add procedure feedback events for `skill.procedure.applied`, `skill.procedure.reinforced`, and `skill.procedure.failed`.
- Attach recalled procedure snapshots to `memory.applied`, then reinforce or fail those procedures when the corresponding tool result arrives.
- Make procedural projection read procedure feedback events so future procedure confidence, success count, failure count, and maturity evolve over time.
- Pass real governance projection evidence into the `memory_recall` policy action and persist the policy action payload for audit.
- Add an extension-level HML E2E test that uses real collector hooks from context to tool call to tool result.

## Acceptance

- User correction after a HML recall emits `memory.reconsolidated`, lowers old traces, and raises the correction trace.
- A procedure shown in HML can be marked applied and then reinforced or failed by tool results.
- `policy.evaluated` for `memory_recall` contains governance evidence instead of placeholder empty arrays.
- Extension lifecycle tests prove `context -> memory.recalled -> tool_call -> memory.applied -> tool_result -> memory.reinforced` without manual append shortcuts.
