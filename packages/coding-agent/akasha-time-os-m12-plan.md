# Akasha M12 Policy Kernel and Typed Time Model Plan

**Goal:** Move Akasha from hard-coded runtime enforcement toward a small local Time OS kernel with policy decisions, daemon callbacks, and typed task/goal projections.

**Scope**

1. **Policy Kernel**
   - Add a generic `policy-kernel.ts` module with decision types: `allow`, `block`, `require_confirmation`, `require_validation`, and `defer`.
   - Evaluate tool calls against policy rules using temporal evidence.
   - Keep the current Tool Gate as the adapter from coding-agent tool calls into the kernel.
   - Record policy interventions as `policy.evaluated` events and then parent `tool.blocked` to the policy event when execution is stopped.

2. **Daemon Callback Queue**
   - Add a queue projection that derives due callbacks from promises, predictions, retention plans, and reflection policy.
   - Add a daemon pass that appends `daemon.tick` and idempotent `time.callback.due` events.
   - Make detached maintenance run the queue pass alongside open-loop, scheduler, embedding, and reflection maintenance.

3. **Typed Task/Goal/Risk Model**
   - Add `task-model.ts` to project typed goals, tasks, decisions, and risks from event history.
   - Keep it purely reconstructable from JSONL.
   - Expose it through exports, tests, and `/akasha task-model`.

4. **Inspection Commands**
   - Add `/akasha queue` for non-mutating daemon callback inspection.
   - Add `/akasha task-model` for goals, tasks, decisions, and risks.
   - Include due callback counts in `/akasha maintain ...` output.

**Non-goals**

- No OS-level daemon installer yet.
- No interactive confirmation UI yet.
- No database migration.
- No LLM-based task extraction in this slice.

**Validation**

- Add unit tests for policy decisions, daemon callback derivation/pass, and typed task projections.
- Run focused Akasha tests, nearby session/settings tests, package build, and full repository check.
