# Akasha M13 Temporal Kernel and Auditable Runtime Plan

**Goal:** Turn the M10-M12 Akasha modules into a tighter temporal runtime slice with a kernel facade, auditable action context, executable policy semantics, callback lifecycle events, and safer JSONL appends.

**Scope**

1. **Temporal Kernel Facade**
   - Add `temporal-kernel.ts` as the internal entrypoint for append, state projection, action context, policy evaluation, daemon pass, and callback completion.
   - Keep `collector-extension.ts` as the akasha-coding-agent adapter, but route action context and policy decisions through the kernel.
   - Avoid a broad rewrite of all existing projections in this slice.

2. **Auditable Action Gate**
   - Add `action_gate.injected` as a first-class event.
   - Record source event ids, sections, content hash, and token estimate whenever the hidden action gate context is injected.
   - Include due callbacks in the action gate so future responsibilities can influence the next model action.

3. **Executable Policy Semantics**
   - Preserve `block` as hard stop.
   - Treat `require_validation` as a validation-required stop with a concrete validation plan in the tool gate result.
   - Treat `require_confirmation` as a confirmation-required stop until interactive confirmation UI exists.
   - Treat `defer` as a scheduled callback instead of a generic block.

4. **Callback Lifecycle**
   - Complete `scheduled -> due -> completed / cancelled`.
   - Add helpers for scheduling, completing, and cancelling callbacks.
   - Add slash commands for completing and cancelling callbacks by callback id.

5. **JSONL Store Safety and Strict Append Validation**
   - Add a lightweight lock file around append.
   - Reload the file under lock before sourceKey dedupe and sequence assignment.
   - Validate new events strictly before writing while keeping old log parsing migration-friendly.

**Non-goals**

- No Akasha product rename or CLI alias in M13.
- No task graph rewrite.
- No suppression closure.
- No artifact validation scope model.
- No LLM/tool-based explicit commitment syscalls.

**Validation**

- Add focused tests for strict schema, lock-aware store dedupe, action gate audit events, policy runtime semantics, callback lifecycle, and temporal kernel facade.
- Run Akasha tests, nearby session/extensions/settings tests, package build, and repo check.
