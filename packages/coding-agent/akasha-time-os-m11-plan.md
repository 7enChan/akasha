# Akasha M11 Time OS Runtime Implementation Plan

**Goal:** Advance Akasha from soft temporal context toward a local Time OS runtime with opt-in hard control, detached maintenance, and user-governed long-term memory.

**Scope**

1. **Hard Tool Gate**
   - Add opt-in tool-call enforcement under `akasha.actionGate`.
   - Block high-risk destructive bash commands before execution.
   - Optionally block widening file changes while existing artifacts are still unverified.
   - Record blocked attempts as append-only Akasha events.

2. **Detached Maintenance Runner**
   - Add a reusable runner that scans Akasha JSONL logs and runs maintenance without an active session turn.
   - Support all-session, project-scoped, and single-session maintenance.
   - Expose the runner through `/akasha maintain [session|project|all]` so a future CLI or cron wrapper can call the same code path.

3. **User Memory Governance**
   - Add user-governance events for pin, unpin, and suppress.
   - Make user timeline projections respect redaction and suppression events.
   - Add inspection and mutation commands: `/akasha memory-review`, `/akasha memory-pin`, `/akasha memory-unpin`, `/akasha memory-suppress`, and `/akasha redact`.

**Non-goals**

- No automatic OS launchd/cron installation yet.
- No GUI memory review panel yet.
- No hard blocking unless the new settings are explicitly enabled.
- No deletion of raw JSONL lines; governance remains append-only and auditable.

**Validation**

- Focused Akasha tests for tool gate, detached maintenance, and memory governance.
- Existing Akasha extension/settings tests.
- Coding-agent build and full repository check.
