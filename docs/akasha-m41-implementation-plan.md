# Akasha M41 Implementation Plan

## Goal

Complete the resume closure protocol: when an Agent handles a pending callback and resolves the related commitment or prediction through an Akasha syscall, Akasha automatically consumes the inbox item and completes the callback lifecycle.

## Scope

- Extend resolution/check syscalls with `callbackId` and `inboxItemId`.
- Make syscall-driven resolution close matching callback inbox items.
- Make syscall-driven resolution append `time.callback.completed`.
- Make pending callback context instruct the Agent to close the loop through explicit syscalls.
- Add focused tests for commitment and prediction closure behavior.

## Implementation Tasks

1. Extend `resolveCommitmentSchema` and `checkPredictionSchema` with optional `callbackId` and `inboxItemId`.
2. Add optional `agentDir` to `AkashaTimeSyscallContext` so syscalls can update the local callback inbox projection.
3. After `promise.resolved` or `prediction.checked/corrected`, complete the matching callback when `callbackId` is present or can be resolved from `inboxItemId`.
4. Append `callback.inbox.consumed` and an inbox status record for actionable inbox items matching the callback or inbox item.
5. Update the pending callback hidden context to tell the Agent to call `akasha_resolve_commitment` or `akasha_check_prediction` with `callbackId` or `inboxItemId`.
6. Update docs and add focused tests that cover `callback.inbox.added -> callback.inbox.consumed` plus `time.callback.completed`.

## Verification

- `npm --prefix packages/coding-agent test -- akasha-time-syscalls akasha-callback-dispatcher akasha-entry-cli akasha-extension`
- `npm --prefix packages/coding-agent run build`
- `npm run check`
