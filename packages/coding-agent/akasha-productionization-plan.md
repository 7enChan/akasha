# Akasha Productionization Implementation Plan

> **For agentic workers:** Continue from `akasha-roadmap.md`. This plan turns the local-first Akasha skeleton into a memory system that can improve real coding-agent work. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Akasha into a dogfoodable temporal memory layer with stable schema handling, persistent temporal recall, scheduled reflection, automatic accountability events, and privacy controls.

**Architecture:** Keep append-only Akasha events as the source of truth. Add small rebuildable indexes around that source: schema validation/migration, embedding records, reflection policy state, Karma extraction, and redaction-aware exports. All new features stay opt-in and local-first by default.

**Tech Stack:** TypeScript, Vitest, JSONL stores, `undici` fetch for optional OpenAI-compatible embeddings, existing coding-agent extension lifecycle hooks, existing settings manager.

---

## Priority 1: Dogfood + Stability

- [x] Add exported schema helpers for `AkashaEvent` validation and migration.
- [x] Replace private JSONL store event parsing with schema helpers.
- [x] Add a `/akasha doctor` command that reports event count, schema issues, redaction count, and retention actions due.
- [x] Keep existing session transcript behavior unchanged.

## Priority 2: Persistent Temporal Recall

- [x] Add Akasha embedding settings under `akasha.embedding`.
- [x] Add an embedding provider interface with deterministic local hash embeddings for tests and OpenAI-compatible HTTP embeddings for real use.
- [x] Add a JSONL embedding store so semantic recall survives restarts.
- [x] Add an embedding indexer that incrementally embeds event summaries and memory crystals.
- [x] Upgrade temporal brief injection to use semantic temporal RAG when embedding is enabled, while falling back to the rule-based brief.
- [x] Add recall evaluation fixtures that assert failed tools, modified files, causal parents, and crystals are recalled.

## Priority 3: Reflection Worker Productization

- [x] Add reflection settings under `akasha.reflection`.
- [x] Add a reflection policy that decides when a pass should run based on events since last reflection and minimum interval.
- [x] Add a maintenance pass that runs scheduler, embedding indexing, open-loop derivation, and reflection in one idempotent operation.
- [x] Run maintenance at safe lifecycle points when enabled.

## Priority 4: Karma Ledger Automation

- [x] Extract `promise.created` from assistant commitments such as "I will run build" / "我会继续检查".
- [x] Extract `prediction.made` from assistant expectations such as "tests should pass" / "应该会修复".
- [x] Add due-time parsing for simple "tomorrow", "later", and ISO date phrases.
- [x] Materialize extracted promise/prediction events with causal parents to the source assistant message.
- [x] Preserve idempotency with deterministic source keys.

## Priority 5: Governance + Privacy Hardening

- [x] Add secret detection for payload strings before append.
- [x] Redact common API keys/tokens in payload fields while preserving event shape and causality.
- [x] Ensure redactions affect temporal brief, temporal RAG export, and governance commands.
- [x] Extend export/import tests to cover redaction-aware JSONL and JSON.

## Validation Plan

- [x] `npm --prefix packages/coding-agent test -- akasha`
- [x] `npm --prefix packages/coding-agent test -- agent-session extensions session-manager`
- [x] `npm --prefix packages/coding-agent run build`

## Implementation Status

Updated 2026-05-11:

- [x] Priority 1 complete.
- [x] Priority 2 complete.
- [x] Priority 3 complete.
- [x] Priority 4 complete.
- [x] Priority 5 complete.
