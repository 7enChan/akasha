# Akasha M55: Operating Closure Plan

## Goal

M55 turns three current gaps into testable runtime seams: real longitudinal memory measurement, a presence control plane seed for Gateway, and a capability-governed action surface model.

## Architecture

Akasha remains event-log first. Dogfood memory eval reads Akasha JSONL logs and runs the existing longitudinal memory harness with latency and budget checks. Gateway presence records device/node identity, capabilities, pairing, heartbeat, and idempotency without changing Telegram delivery behavior. Action surfaces model non-chat worlds as capability declarations that map into runtime policy and auditable action events.

## Scope

- Add dogfood eval helpers for real or fixture Akasha event logs.
- Add action surface types, registry helpers, policy mapping, and audit event drafts.
- Add gateway presence types, pairing decisions, heartbeat projection, idempotency keys, and audit event drafts.
- Add focused tests for each seam.

## Non-goals

- No real model calls.
- No broad Gateway protocol rewrite.
- No browser, Docker, SSH, or mobile execution implementation in this slice.
- No change to the existing coding-agent tool execution path.

## Files

- `packages/coding-agent/src/core/akasha/dogfood-memory-eval.ts`
- `packages/coding-agent/src/core/akasha/action-surface.ts`
- `packages/coding-agent/src/gateway/presence.ts`
- `packages/coding-agent/test/akasha-dogfood-memory-eval.test.ts`
- `packages/coding-agent/test/akasha-action-surface.test.ts`
- `packages/coding-agent/test/akasha-gateway-presence.test.ts`

## Acceptance

- Dogfood eval can load JSONL logs from disk, run longitudinal cases, and fail on recall, pollution, coverage, token, or latency budget violations.
- Action surfaces can declare capabilities, map requests to runtime policy, block missing capabilities, require confirmation for critical capabilities, and produce strict audit event drafts.
- Gateway presence can produce stable device/node ids, deterministic idempotency keys, pairing decisions, heartbeat status, projected latest presence, and strict audit event drafts.
- Focused tests and `npm run check` pass.
