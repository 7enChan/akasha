# Akasha Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve Akasha from the current M1 local event sidecar into a time-native agent runtime with projections, recall evaluation, open loops, reflection crystals, temporal RAG, world-state projections, Karma Ledger, scheduling, governance, and multi-runtime adapters.

**Architecture:** Akasha keeps append-only events as the source of truth and treats every derived view as a rebuildable projection. The first product surface is `akasha-coding-agent`; later stages extract a stable core SDK so other agent runtimes can map their lifecycles into the same time model.

**Tech Stack:** TypeScript, Vitest, Node.js filesystem JSONL for M1, optional SQLite/Postgres for later stores, existing `akasha-coding-agent` extension hooks, existing settings/resource-loader/session-manager patterns.

---

## Current Baseline

The current repository has the M1 sidecar foundation:

- Settings: `akasha.enabled`, `akasha.injectTemporalBrief`, `akasha.maxBriefEvents`, `akasha.eventLogDir`.
- Core module: `packages/coding-agent/src/core/akasha/`.
- Store: append-only JSONL per session.
- Collector: built-in extension injected by `DefaultResourceLoader` when enabled.
- Commands: `/akasha status`, `/akasha timeline [n]`, `/akasha why <eventId|toolCallId>`.
- Initial tests: store, mapper, brief, collector extension, settings, resource-loader.

The next roadmap starts from this baseline. Do not rewrite M1 unless a later task exposes a concrete defect.

## Roadmap Overview

| Wave | Milestone | Duration | Result |
|---|---:|---:|---|
| Wave 1 | M1.1 + M1.2 | 1-2 weeks | Temporal projections, temporal state, recall eval harness |
| Wave 2 | M2 | 1-2 weeks | Open loops and Karma seed events |
| Wave 3 | M3 | 2-3 weeks | Reflection worker and long-term memory crystals |
| Wave 4 | M4 | 2-3 weeks | Temporal RAG and embedding timeline |
| Wave 5 | M5 | 2-4 weeks | Time-spatial world model projections |
| Wave 6 | M6 | 2-4 weeks | Full Karma Ledger prediction/promise accountability |
| Wave 7 | M7 | 2-3 weeks | Scheduler, heartbeat, cross-session continuity |
| Wave 8 | M8 | 3-5 weeks | Multi-runtime Akasha SDK and adapters |
| Wave 9 | M9 | 2-4 weeks | Retention, redaction, export/import, trust controls |

Each wave must leave the product usable. If a wave is paused, Akasha must still be opt-in and the normal session transcript behavior must remain unchanged.

## Implementation Status

Updated 2026-05-11:

- [x] Wave 1: temporal projections, causal index, temporal state, recall ranking, `/akasha explain-current`.
- [x] Wave 2: explicit open-loop ledger events, derived loop open/resolve materialization, `/akasha open-loops`.
- [x] Wave 3: reflection pass scaffold, failure/preference crystals, long-term `memory.crystal.created` events.
- [x] Wave 4: in-memory embedding store and temporal RAG retrieval scaffold with semantic, causal, and unresolved-loop weighting.
- [x] Wave 5: artifact state, project state, world model projections, `/akasha project-state`.
- [x] Wave 6: Karma Ledger projections for promises and predictions, `/akasha karma`.
- [x] Wave 7: local cross-session event-log index and scheduler pass for overdue promises/due predictions.
- [x] Wave 8: generic runtime adapter and public Akasha client SDK.
- [x] Wave 9: retention planning, redaction projection, JSON/JSONL export/import, `/akasha governance`.

The implementation is still local-first and opt-in. Later production hardening should focus on real embedding providers, persistent indexes, UI surfaces, and background scheduling outside the test harness.

## Global Engineering Rules

- [x] Keep `AkashaEvent` append-only. Corrections and deletions are new events, not mutations.
- [x] Keep all projections rebuildable from event logs.
- [x] Keep full file contents and full command output out of event payloads.
- [x] Keep Akasha off by default.
- [x] Add focused tests before changing recall/projection behavior.
- [x] Run `npm --prefix packages/coding-agent test -- akasha` after Akasha changes.
- [x] Run `npm --prefix packages/coding-agent run build` before closing any milestone.
- [x] Update this roadmap when a milestone changes scope.

---

## Wave 1: M1.1 Temporal State Projections

**Goal:** Convert raw event history into current temporal state: active files, failed tools, current intent, causal graph, and open-loop candidates.

**Files:**

- Create: `packages/coding-agent/src/core/akasha/projections.ts`
- Create: `packages/coding-agent/src/core/akasha/temporal-state.ts`
- Modify: `packages/coding-agent/src/core/akasha/index.ts`
- Modify: `packages/coding-agent/src/core/akasha/commands.ts`
- Test: `packages/coding-agent/test/akasha-projections.test.ts`
- Test: `packages/coding-agent/test/akasha-temporal-state.test.ts`

### Task 1.1: Define Projection Types

- [ ] **Step 1: Add projection type tests**

Create `packages/coding-agent/test/akasha-temporal-state.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { buildTemporalState } from "../src/core/akasha/temporal-state.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("buildTemporalState", () => {
	it("summarizes current intent, active files, failed tools, and open loop candidates", () => {
		const events = [
			event(1, "message.user.submitted", { text: "Patch src/app.ts and run tests" }, { actor: "user" }),
			event(2, "artifact.patched", { path: "src/app.ts", isError: false }, { objectId: "src/app.ts" }),
			event(3, "tool.completed", { toolName: "bash", isError: true, text: "test failed" }, { toolCallId: "call-1", objectId: "bash" }),
		];

		const state = buildTemporalState(events);

		expect(state.currentIntent?.text).toContain("Patch src/app.ts");
		expect(state.activeFiles.map((file) => file.path)).toEqual(["src/app.ts"]);
		expect(state.failedTools.map((tool) => tool.toolCallId)).toEqual(["call-1"]);
		expect(state.openLoopCandidates.map((loop) => loop.reason)).toContain("tool_failed_without_recovery");
	});
});

function event(
	sequence: number,
	kind: AkashaEvent["kind"],
	payload: Record<string, unknown>,
	overrides: Partial<AkashaEvent> = {},
): AkashaEvent {
	return {
		eventId: `evt-${sequence}`,
		kind,
		sessionId: "session-1",
		streamId: "session:session-1",
		sequence,
		eventTime: new Date(sequence * 1000).toISOString(),
		recordedTime: new Date(sequence * 1000).toISOString(),
		actor: "system",
		parentEventIds: [],
		payload,
		importance: 0.5,
		ttlPolicy: "long_term",
		version: 1,
		...overrides,
	};
}
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm --prefix packages/coding-agent test -- akasha-temporal-state
```

Expected: fail because `temporal-state.ts` does not exist.

- [ ] **Step 3: Implement projection types and builder**

Create `packages/coding-agent/src/core/akasha/temporal-state.ts`:

```ts
import type { AkashaEvent } from "./types.js";

export interface AkashaCurrentIntent {
	eventId: string;
	text: string;
	eventTime: string;
}

export interface AkashaActiveFile {
	path: string;
	lastEventId: string;
	lastKind: AkashaEvent["kind"];
	lastEventTime: string;
	hasUnverifiedPatch: boolean;
}

export interface AkashaFailedTool {
	eventId: string;
	toolCallId: string | undefined;
	toolName: string;
	text: string;
	eventTime: string;
}

export type AkashaOpenLoopReason =
	| "artifact_changed_without_validation"
	| "tool_failed_without_recovery"
	| "user_requested_followup";

export interface AkashaOpenLoopCandidate {
	rootEventId: string;
	reason: AkashaOpenLoopReason;
	summary: string;
	objectId?: string;
	toolCallId?: string;
}

export interface AkashaTemporalState {
	currentIntent?: AkashaCurrentIntent;
	activeFiles: AkashaActiveFile[];
	failedTools: AkashaFailedTool[];
	openLoopCandidates: AkashaOpenLoopCandidate[];
	lastCompactionEventId?: string;
	lastBranchSummaryEventId?: string;
}

export function buildTemporalState(events: AkashaEvent[]): AkashaTemporalState {
	const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
	const activeFiles = new Map<string, AkashaActiveFile>();
	const failedTools = new Map<string, AkashaFailedTool>();
	const validations = new Set<string>();
	let currentIntent: AkashaCurrentIntent | undefined;
	let lastCompactionEventId: string | undefined;
	let lastBranchSummaryEventId: string | undefined;

	for (const event of ordered) {
		if (event.kind === "message.user.submitted") {
			const text = typeof event.payload.text === "string" ? event.payload.text : "";
			currentIntent = { eventId: event.eventId, text, eventTime: event.eventTime };
		}

		if (event.kind === "artifact.read" || event.kind === "artifact.written" || event.kind === "artifact.patched") {
			const path = typeof event.payload.path === "string" ? event.payload.path : event.objectId;
			if (path) {
				activeFiles.set(path, {
					path,
					lastEventId: event.eventId,
					lastKind: event.kind,
					lastEventTime: event.eventTime,
					hasUnverifiedPatch: event.kind === "artifact.patched" || event.kind === "artifact.written",
				});
			}
		}

		if (event.kind === "command.executed" && typeof event.payload.command === "string") {
			const command = event.payload.command.toLowerCase();
			if (command.includes("test") || command.includes("tsc") || command.includes("build")) {
				for (const file of activeFiles.values()) {
					validations.add(file.path);
				}
			}
		}

		if (event.kind === "tool.completed") {
			const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : event.objectId ?? "tool";
			if (event.payload.isError === true) {
				failedTools.set(event.toolCallId ?? event.eventId, {
					eventId: event.eventId,
					toolCallId: event.toolCallId,
					toolName,
					text: typeof event.payload.text === "string" ? event.payload.text : "",
					eventTime: event.eventTime,
				});
			} else if (event.toolCallId) {
				failedTools.delete(event.toolCallId);
			}
		}

		if (event.kind === "context.compacted") lastCompactionEventId = event.eventId;
		if (event.kind === "branch.summary_created") lastBranchSummaryEventId = event.eventId;
	}

	const openLoopCandidates: AkashaOpenLoopCandidate[] = [];
	for (const file of activeFiles.values()) {
		if (file.hasUnverifiedPatch && !validations.has(file.path)) {
			openLoopCandidates.push({
				rootEventId: file.lastEventId,
				reason: "artifact_changed_without_validation",
				summary: `${file.path} changed without a later validation command`,
				objectId: file.path,
			});
		}
	}
	for (const failed of failedTools.values()) {
		openLoopCandidates.push({
			rootEventId: failed.eventId,
			reason: "tool_failed_without_recovery",
			summary: `${failed.toolName} failed without a later successful recovery`,
			toolCallId: failed.toolCallId,
		});
	}

	return {
		currentIntent,
		activeFiles: [...activeFiles.values()].sort((a, b) => b.lastEventTime.localeCompare(a.lastEventTime)),
		failedTools: [...failedTools.values()].sort((a, b) => b.eventTime.localeCompare(a.eventTime)),
		openLoopCandidates,
		lastCompactionEventId,
		lastBranchSummaryEventId,
	};
}
```

- [ ] **Step 4: Export the builder**

Modify `packages/coding-agent/src/core/akasha/index.ts`:

```ts
export { buildTemporalState } from "./temporal-state.js";
export type {
	AkashaActiveFile,
	AkashaCurrentIntent,
	AkashaFailedTool,
	AkashaOpenLoopCandidate,
	AkashaOpenLoopReason,
	AkashaTemporalState,
} from "./temporal-state.js";
```

- [ ] **Step 5: Run the test**

Run:

```bash
npm --prefix packages/coding-agent test -- akasha-temporal-state
```

Expected: pass.

### Task 1.2: Add Projection Helpers

- [ ] **Step 1: Add projection tests**

Create `packages/coding-agent/test/akasha-projections.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCausalIndex, findCausalPath } from "../src/core/akasha/projections.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha projections", () => {
	it("builds a causal index and finds a root-to-target path", () => {
		const root = event("root", 1, []);
		const child = event("child", 2, ["root"]);
		const leaf = event("leaf", 3, ["child"]);
		const index = buildCausalIndex([leaf, child, root]);

		expect(findCausalPath(index, "leaf").map((item) => item.eventId)).toEqual(["root", "child", "leaf"]);
	});
});

function event(eventId: string, sequence: number, parentEventIds: string[]): AkashaEvent {
	return {
		eventId,
		kind: "message.user.submitted",
		sessionId: "session-1",
		streamId: "session:session-1",
		sequence,
		eventTime: new Date(sequence * 1000).toISOString(),
		recordedTime: new Date(sequence * 1000).toISOString(),
		actor: "user",
		parentEventIds,
		payload: { text: eventId },
		importance: 0.5,
		ttlPolicy: "long_term",
		version: 1,
	};
}
```

- [ ] **Step 2: Implement `projections.ts`**

Create `packages/coding-agent/src/core/akasha/projections.ts`:

```ts
import type { AkashaEvent } from "./types.js";

export interface AkashaCausalIndex {
	byId: Map<string, AkashaEvent>;
	childrenByParentId: Map<string, AkashaEvent[]>;
}

export function buildCausalIndex(events: AkashaEvent[]): AkashaCausalIndex {
	const byId = new Map<string, AkashaEvent>();
	const childrenByParentId = new Map<string, AkashaEvent[]>();

	for (const event of events) {
		byId.set(event.eventId, event);
		for (const parentId of event.parentEventIds) {
			const children = childrenByParentId.get(parentId) ?? [];
			children.push(event);
			childrenByParentId.set(parentId, children);
		}
	}

	for (const children of childrenByParentId.values()) {
		children.sort((a, b) => a.sequence - b.sequence);
	}

	return { byId, childrenByParentId };
}

export function findCausalPath(index: AkashaCausalIndex, targetEventId: string): AkashaEvent[] {
	const target = index.byId.get(targetEventId);
	if (!target) return [];
	const path: AkashaEvent[] = [];
	const seen = new Set<string>();

	const visit = (event: AkashaEvent): void => {
		if (seen.has(event.eventId)) return;
		seen.add(event.eventId);
		for (const parentId of event.parentEventIds) {
			const parent = index.byId.get(parentId);
			if (parent) visit(parent);
		}
		path.push(event);
	};

	visit(target);
	return path.sort((a, b) => a.sequence - b.sequence);
}
```

- [ ] **Step 3: Export helpers**

Modify `packages/coding-agent/src/core/akasha/index.ts`:

```ts
export { buildCausalIndex, findCausalPath } from "./projections.js";
export type { AkashaCausalIndex } from "./projections.js";
```

- [ ] **Step 4: Run projection tests**

Run:

```bash
npm --prefix packages/coding-agent test -- akasha-projections akasha-temporal-state
```

Expected: pass.

### Task 1.3: Add `/akasha explain-current` and `/akasha open-loops`

**Files:**

- Modify: `packages/coding-agent/src/core/akasha/commands.ts`
- Test: `packages/coding-agent/test/akasha-extension.test.ts`

- [ ] **Step 1: Add command test expectations**

Extend the existing collector extension test to call:

```ts
await command?.handler("explain-current", fakeCommandContext(notices));
await command?.handler("open-loops", fakeCommandContext(notices));
expect(notices.join("\n")).toContain("Current intent");
expect(notices.join("\n")).toContain("Open loops");
```

- [ ] **Step 2: Implement command branches**

In `commands.ts`, import `buildTemporalState` and add two subcommands:

```ts
if (subcommand === "explain-current") {
	const state = buildTemporalState(store.buildTimeline({ limit: 200 }));
	ctx.ui.notify(formatTemporalState(state), "info");
	return;
}

if (subcommand === "open-loops") {
	const state = buildTemporalState(store.buildTimeline({ limit: 200 }));
	ctx.ui.notify(formatOpenLoops(state.openLoopCandidates), "info");
	return;
}
```

Add format helpers in the same file:

```ts
function formatTemporalState(state: AkashaTemporalState): string {
	const lines = ["Current intent:", state.currentIntent?.text ?? "(none)", "", "Active files:"];
	for (const file of state.activeFiles.slice(0, 10)) {
		lines.push(`- ${file.path} (${file.lastKind})`);
	}
	lines.push("", "Failed tools:");
	for (const tool of state.failedTools.slice(0, 10)) {
		lines.push(`- ${tool.toolName}${tool.toolCallId ? ` [${tool.toolCallId}]` : ""}`);
	}
	lines.push("", "Open loops:");
	for (const loop of state.openLoopCandidates.slice(0, 10)) {
		lines.push(`- ${loop.reason}: ${loop.summary}`);
	}
	return lines.join("\n");
}

function formatOpenLoops(loops: AkashaOpenLoopCandidate[]): string {
	if (loops.length === 0) return "Open loops:\n(none)";
	return ["Open loops:", ...loops.map((loop) => `- ${loop.reason}: ${loop.summary}`)].join("\n");
}
```

- [ ] **Step 3: Run command tests**

Run:

```bash
npm --prefix packages/coding-agent test -- akasha-extension
```

Expected: pass.

---

## Wave 1: M1.2 Temporal Recall Eval Harness

**Goal:** Make temporal recall measurable and regression-safe.

**Files:**

- Create: `packages/coding-agent/src/core/akasha/recall-policy.ts`
- Create: `packages/coding-agent/test/fixtures/akasha/edit-failure-recovery.ts`
- Create: `packages/coding-agent/test/fixtures/akasha/branch-compaction.ts`
- Create: `packages/coding-agent/test/akasha-recall-policy.test.ts`
- Modify: `packages/coding-agent/src/core/akasha/brief.ts`

### Task 1.4: Extract Recall Policy From Brief

- [ ] **Step 1: Add recall policy test**

Create `packages/coding-agent/test/akasha-recall-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rankRecallEvents } from "../src/core/akasha/recall-policy.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("rankRecallEvents", () => {
	it("prioritizes failed tools and modified artifacts over generic assistant text", () => {
		const ranked = rankRecallEvents([
			event(1, "message.agent.completed", { text: "I will help" }, 0.6),
			event(2, "artifact.patched", { path: "src/app.ts" }, 0.9),
			event(3, "tool.completed", { toolName: "bash", isError: true, text: "failed" }, 0.95),
		]);

		expect(ranked.slice(0, 2).map((item) => item.kind)).toEqual(["tool.completed", "artifact.patched"]);
	});
});

function event(
	sequence: number,
	kind: AkashaEvent["kind"],
	payload: Record<string, unknown>,
	importance: number,
): AkashaEvent {
	return {
		eventId: `evt-${sequence}`,
		kind,
		sessionId: "session-1",
		streamId: "session:session-1",
		sequence,
		eventTime: new Date(sequence * 1000).toISOString(),
		recordedTime: new Date(sequence * 1000).toISOString(),
		actor: "system",
		parentEventIds: [],
		payload,
		importance,
		ttlPolicy: "long_term",
		version: 1,
	};
}
```

- [ ] **Step 2: Implement `recall-policy.ts`**

Create `packages/coding-agent/src/core/akasha/recall-policy.ts`:

```ts
import type { AkashaEvent } from "./types.js";

const KIND_PRIORITY: Partial<Record<AkashaEvent["kind"], number>> = {
	"artifact.patched": 10,
	"artifact.written": 10,
	"tool.completed": 9,
	"command.executed": 8,
	"message.user.submitted": 8,
	"context.compacted": 7,
	"branch.summary_created": 7,
	"message.agent.completed": 5,
	"artifact.read": 4,
};

export function rankRecallEvents(events: AkashaEvent[], queryText?: string): AkashaEvent[] {
	const query = queryText?.trim().toLowerCase();
	return [...events].sort((a, b) => scoreEvent(b, query) - scoreEvent(a, query) || b.sequence - a.sequence);
}

function scoreEvent(event: AkashaEvent, query: string | undefined): number {
	let score = event.importance * 10 + (KIND_PRIORITY[event.kind] ?? 1);
	if (event.kind === "tool.completed" && event.payload.isError === true) score += 8;
	if (event.kind === "artifact.patched" || event.kind === "artifact.written") score += 5;
	if (query && JSON.stringify(event).toLowerCase().includes(query)) score += 6;
	return score;
}
```

- [ ] **Step 3: Use recall policy in brief**

Modify `packages/coding-agent/src/core/akasha/brief.ts` so `buildTemporalBrief()` calls `rankRecallEvents(recent, options.queryText)` and then slices/sorts by sequence for rendering.

- [ ] **Step 4: Run recall and brief tests**

Run:

```bash
npm --prefix packages/coding-agent test -- akasha-recall-policy akasha-brief
```

Expected: pass.

---

## Wave 2: M2 Open Loops and Karma Seed

**Goal:** Promote open-loop candidates into explicit events that can be tracked, progressed, blocked, and resolved.

**Files:**

- Modify: `packages/coding-agent/src/core/akasha/types.ts`
- Create: `packages/coding-agent/src/core/akasha/open-loops.ts`
- Modify: `packages/coding-agent/src/core/akasha/collector-extension.ts`
- Modify: `packages/coding-agent/src/core/akasha/commands.ts`
- Test: `packages/coding-agent/test/akasha-open-loops.test.ts`

### Task 2.1: Add Loop Event Kinds

- [ ] Add event kinds to `AkashaEventKind`:

```ts
| "loop.opened"
| "loop.progressed"
| "loop.blocked"
| "loop.resolved"
| "promise.created"
| "promise.updated"
| "promise.resolved"
| "prediction.made"
| "prediction.checked"
| "prediction.corrected"
```

- [ ] Run:

```bash
npm --prefix packages/coding-agent run build
```

Expected: pass.

### Task 2.2: Implement Open Loop Derivation

- [ ] Create `packages/coding-agent/test/akasha-open-loops.test.ts` with three cases:

```ts
import { describe, expect, it } from "vitest";
import { deriveOpenLoopEvents } from "../src/core/akasha/open-loops.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("deriveOpenLoopEvents", () => {
	it("opens a loop for patched artifacts without validation", () => {
		const loops = deriveOpenLoopEvents([event(1, "artifact.patched", { path: "src/app.ts" })], "session-1", "session:session-1");
		expect(loops.map((loop) => loop.kind)).toEqual(["loop.opened"]);
		expect(loops[0]?.payload.reason).toBe("artifact_changed_without_validation");
	});
});

function event(sequence: number, kind: AkashaEvent["kind"], payload: Record<string, unknown>): AkashaEvent {
	return {
		eventId: `evt-${sequence}`,
		kind,
		sessionId: "session-1",
		streamId: "session:session-1",
		sequence,
		eventTime: new Date(sequence * 1000).toISOString(),
		recordedTime: new Date(sequence * 1000).toISOString(),
		actor: "tool",
		parentEventIds: [],
		payload,
		objectId: typeof payload.path === "string" ? payload.path : undefined,
		importance: 0.8,
		ttlPolicy: "long_term",
		version: 1,
	};
}
```

- [ ] Implement `deriveOpenLoopEvents()` in `open-loops.ts`:

```ts
import { v7 as uuidv7 } from "uuid";
import { buildTemporalState } from "./temporal-state.js";
import type { AkashaEvent, AkashaEventDraft } from "./types.js";

export function deriveOpenLoopEvents(events: AkashaEvent[], sessionId: string, streamId: string): AkashaEventDraft[] {
	const state = buildTemporalState(events);
	return state.openLoopCandidates.map((loop) => ({
		kind: "loop.opened",
		sessionId,
		streamId,
		eventTime: new Date().toISOString(),
		actor: "system",
		subjectId: "akasha",
		objectId: loop.objectId,
		toolCallId: loop.toolCallId,
		sourceKey: `open-loop:${loop.rootEventId}:${loop.reason}`,
		parentEventIds: [loop.rootEventId],
		correlationId: uuidv7(),
		payload: {
			reason: loop.reason,
			summary: loop.summary,
			rootEventId: loop.rootEventId,
			state: "open",
		},
		importance: 0.85,
		ttlPolicy: "long_term",
	}));
}
```

- [ ] Run:

```bash
npm --prefix packages/coding-agent test -- akasha-open-loops
```

Expected: pass.

### Task 2.3: Add Loop Resolution Rules

- [ ] Add tests for:
  - A validation command after patch resolves `artifact_changed_without_validation`.
  - A successful same-tool result after failure resolves `tool_failed_without_recovery`.

- [ ] Implement `loop.resolved` derivation by comparing old open loop events with newer validating events.

- [ ] Run:

```bash
npm --prefix packages/coding-agent test -- akasha-open-loops akasha-temporal-state
```

Expected: pass.

---

## Wave 3: M3 Reflection Worker and Memory Crystals

**Goal:** Consolidate time spans into explicit long-term crystals with evidence, confidence, and expiry.

**Files:**

- Modify: `packages/coding-agent/src/core/akasha/types.ts`
- Create: `packages/coding-agent/src/core/akasha/reflection-worker.ts`
- Create: `packages/coding-agent/src/core/akasha/crystals.ts`
- Create: `packages/coding-agent/test/akasha-crystals.test.ts`
- Create: `packages/coding-agent/test/akasha-reflection-worker.test.ts`

### Task 3.1: Add Crystal Event Kinds

- [ ] Add event kinds:

```ts
| "reflection.started"
| "reflection.completed"
| "memory.crystal.created"
| "memory.crystal.updated"
| "pattern.detected"
| "preference.inferred"
| "failure.lesson_learned"
| "workflow.optimized"
```

- [ ] Add `AkashaCrystalPayload` type in `crystals.ts`:

```ts
export interface AkashaCrystalPayload {
	kind: "preference" | "failure_lesson" | "workflow" | "pattern";
	statement: string;
	timeRange: { from: string; to: string };
	supportingEventIds: string[];
	confidence: number;
	expiresAt?: string;
}
```

### Task 3.2: Implement Rule-based Crystal Seed

- [ ] Add a test where repeated failed `npm test` events produce a `failure.lesson_learned` draft.
- [ ] Implement a rule-based `createCrystalDrafts(events)` before using LLM reflection.
- [ ] Require every crystal draft to include `supportingEventIds`.
- [ ] Run:

```bash
npm --prefix packages/coding-agent test -- akasha-crystals
```

Expected: pass.

### Task 3.3: Add Reflection Worker Boundary

- [ ] Implement `runReflectionPass(store, options)` that:
  - reads a time window from store,
  - appends `reflection.started`,
  - creates crystal drafts,
  - appends `memory.crystal.created`,
  - appends `reflection.completed`.

- [ ] Keep it manually callable first; do not add background scheduling in M3.
- [ ] Run:

```bash
npm --prefix packages/coding-agent test -- akasha-reflection-worker akasha-crystals
```

Expected: pass.

---

## Wave 4: M4 Temporal RAG

**Goal:** Add semantic recall only after temporal and causal ranking are stable.

**Files:**

- Create: `packages/coding-agent/src/core/akasha/embedding-store.ts`
- Create: `packages/coding-agent/src/core/akasha/temporal-rag.ts`
- Modify: `packages/coding-agent/src/core/akasha/brief.ts`
- Test: `packages/coding-agent/test/akasha-temporal-rag.test.ts`

### Task 4.1: Define Embedding Store Interface

- [ ] Create a storage-agnostic interface:

```ts
export interface AkashaEmbeddingRecord {
	id: string;
	targetType: "event" | "crystal";
	targetId: string;
	text: string;
	vector: number[];
	createdAt: string;
}

export interface AkashaEmbeddingStore {
	upsert(record: AkashaEmbeddingRecord): Promise<void>;
	search(queryVector: number[], options: { limit: number; targetTypes?: Array<"event" | "crystal"> }): Promise<Array<{ record: AkashaEmbeddingRecord; similarity: number }>>;
}
```

- [ ] Add an in-memory implementation for tests only.

### Task 4.2: Implement Temporal RAG Ranking

- [ ] Add tests proving:
  - Semantic match alone cannot outrank unresolved failure.
  - Stale resolved loop is suppressed.
  - Causal parents are expanded with the selected event.

- [ ] Implement `retrieveTemporalContext()` with this pipeline:

```text
time-window filter -> semantic candidates -> causal expansion -> temporal score -> final context bundle
```

- [ ] Run:

```bash
npm --prefix packages/coding-agent test -- akasha-temporal-rag
```

Expected: pass.

---

## Wave 5: M5 Time-spatial World Model

**Goal:** Represent files, project goals, tasks, actors, and environment state as projections over time.

**Files:**

- Create: `packages/coding-agent/src/core/akasha/world-model.ts`
- Create: `packages/coding-agent/src/core/akasha/artifact-state.ts`
- Create: `packages/coding-agent/src/core/akasha/project-state.ts`
- Test: `packages/coding-agent/test/akasha-world-model.test.ts`

### Task 5.1: Artifact State Projection

- [ ] Add tests for:
  - read-only file state,
  - patched but unverified state,
  - patched and verified state,
  - failed patch state.

- [ ] Implement:

```ts
export interface AkashaArtifactState {
	path: string;
	lastReadEventId?: string;
	lastWriteEventId?: string;
	lastPatchEventId?: string;
	lastValidationEventId?: string;
	status: "observed" | "modified_unverified" | "modified_verified" | "failed";
}
```

- [ ] Run:

```bash
npm --prefix packages/coding-agent test -- akasha-world-model
```

Expected: pass.

### Task 5.2: Project State Projection

- [ ] Derive project state from user intents, branch summaries, compactions, open loops, and crystals.
- [ ] Add `/akasha project-state`.
- [ ] Verify it lists current goal, blockers, active files, recent decisions, and unresolved loops.

---

## Wave 6: M6 Karma Ledger

**Goal:** Track promises and predictions through future verification and correction.

**Files:**

- Create: `packages/coding-agent/src/core/akasha/karma-ledger.ts`
- Modify: `packages/coding-agent/src/core/akasha/types.ts`
- Modify: `packages/coding-agent/src/core/akasha/commands.ts`
- Test: `packages/coding-agent/test/akasha-karma-ledger.test.ts`

### Task 6.1: Promise Lifecycle

- [ ] Add tests for promise lifecycle:

```text
promise.created -> promise.updated -> promise.resolved
```

- [ ] Implement `buildKarmaLedger(events)` returning open, overdue, resolved, and corrected records.
- [ ] Add `/akasha karma`.

### Task 6.2: Prediction Lifecycle

- [ ] Add tests for:

```text
prediction.made -> prediction.checked -> prediction.corrected
```

- [ ] Implement prediction error attribution payload:

```ts
{
	expected: string;
	actual: string;
	errorType: "tool_error" | "wrong_assumption" | "environment_changed" | "user_goal_changed";
	lesson: string;
}
```

- [ ] Ensure future recall boosts `prediction.corrected` and `failure.lesson_learned`.

---

## Wave 7: M7 Scheduler and Cross-session Continuity

**Goal:** Let Akasha continue across sessions and time gaps without becoming a hidden autonomous actor.

**Files:**

- Create: `packages/coding-agent/src/core/akasha/scheduler.ts`
- Create: `packages/coding-agent/src/core/akasha/session-index.ts`
- Test: `packages/coding-agent/test/akasha-session-index.test.ts`
- Test: `packages/coding-agent/test/akasha-scheduler.test.ts`

### Task 7.1: Session Index

- [ ] Index session event logs by project cwd and session id.
- [ ] Add `listSessionsForProject(agentDir, cwd)` and `loadProjectTimeline(agentDir, cwd)`.
- [ ] Add tests with two fake session JSONL files.

### Task 7.2: Manual Scheduler Pass

- [ ] Implement `runAkashaSchedulerPass(store, now)` that checks due promises and predictions.
- [ ] Append `promise.updated` or `prediction.checked` drafts; do not send user-visible notifications yet.
- [ ] Add command `/akasha scheduler-check`.

---

## Wave 8: M8 Multi-runtime SDK

**Goal:** Extract reusable Akasha core so other Agent runtimes can adapt into the same temporal model.

**Files:**

- Create: `packages/coding-agent/src/core/akasha/runtime-adapter.ts`
- Create: `packages/coding-agent/src/core/akasha/sdk.ts`
- Modify: `packages/coding-agent/src/core/akasha/collector-extension.ts`
- Test: `packages/coding-agent/test/akasha-runtime-adapter.test.ts`

### Task 8.1: Runtime Adapter Contract

- [ ] Define:

```ts
export interface AkashaRuntimeAdapter<TEvent> {
	name: string;
	map(event: TEvent, context: AkashaRuntimeContext): AkashaEventDraft[];
}

export interface AkashaRuntimeContext {
	sessionId: string;
	streamId: string;
	now: () => string;
}
```

- [ ] Refactor `collector-extension.ts` to use adapter functions without changing output events.
- [ ] Verify existing Akasha tests still pass.

### Task 8.2: Compatibility Fixtures

- [ ] Add fixture tests proving the same lifecycle produces equivalent causal chains through the adapter contract.

---

## Wave 9: M9 Governance and Trust

**Goal:** Give users control over what Akasha remembers, forgets, exports, and redacts.

**Files:**

- Create: `packages/coding-agent/src/core/akasha/retention.ts`
- Create: `packages/coding-agent/src/core/akasha/redaction.ts`
- Create: `packages/coding-agent/src/core/akasha/export.ts`
- Modify: `packages/coding-agent/src/core/akasha/types.ts`
- Test: `packages/coding-agent/test/akasha-retention.test.ts`
- Test: `packages/coding-agent/test/akasha-redaction.test.ts`

### Task 9.1: Retention Policy

- [ ] Implement retention decisions for:

```text
ephemeral -> eligible after session end
session -> eligible after configured days
short_term -> eligible after configured days
long_term -> retained until explicit policy
permanent -> retained until explicit redaction
```

- [ ] Tests must prove policy returns decisions without deleting files.

### Task 9.2: Redaction Events

- [ ] Add event kind `event.redacted`.
- [ ] Implement redaction projection that hides payloads for redacted event ids while keeping causal topology.
- [ ] Add tests proving causal chain still exists but payload is unavailable.

### Task 9.3: Export

- [ ] Implement JSON export for a session or project timeline.
- [ ] Exclude redacted payloads.
- [ ] Include schema version, exportedAt, sessionId/project cwd, and event count.

---

## Release Gates

### Alpha Gate: After Wave 1

- [ ] Akasha can explain current state from event logs.
- [ ] Temporal recall evals protect active files, failures, and open-loop candidates.
- [ ] Commands: `status`, `timeline`, `why`, `explain-current`, `open-loops`.

### Beta Gate: After Wave 3

- [ ] Open loops are explicit events.
- [ ] Reflection worker creates evidence-backed crystals.
- [ ] Temporal brief uses events, projections, loops, and crystals.

### Product Gate: After Wave 6

- [ ] Karma Ledger tracks promises and predictions.
- [ ] Agent can cite past failed predictions and changed behavior.
- [ ] Users can inspect and disable Akasha outputs.

### Platform Gate: After Wave 9

- [ ] Runtime adapter contract exists.
- [ ] Cross-session continuity works.
- [ ] Retention, redaction, export, and audit behavior are tested.

## Standard Validation Commands

Run after every task touching Akasha:

```bash
npm --prefix packages/coding-agent test -- akasha
```

Run after command/settings/resource-loader changes:

```bash
npm --prefix packages/coding-agent test -- resource-loader settings-manager
```

Run after session/extension integration changes:

```bash
npm --prefix packages/coding-agent test -- agent-session extensions session-manager
```

Run before closing any wave:

```bash
npm --prefix packages/coding-agent run build
```

Run formatting/checks only on touched files:

```bash
npx biome check --write <changed-files>
```

## First Execution Recommendation

Start with Wave 1 and keep the first PR narrow:

- [ ] Implement `temporal-state.ts`.
- [ ] Implement `projections.ts`.
- [ ] Add `/akasha explain-current`.
- [ ] Add `/akasha open-loops`.
- [ ] Extract `recall-policy.ts`.
- [ ] Add recall fixtures.
- [ ] Run Akasha focused tests and package build.

Do not start M2 until Wave 1 has tests proving projection rebuild and recall ranking are stable.
