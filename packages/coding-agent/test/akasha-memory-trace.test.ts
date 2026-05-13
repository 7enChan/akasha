import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { createMemoryGovernanceEvent } from "../src/core/akasha/memory-governance.js";
import { buildAkashaMemoryTraces } from "../src/core/akasha/memory-trace.js";
import { buildCachedAkashaMemoryTraces } from "../src/core/akasha/memory-trace-cache.js";
import type { AkashaEvent, AkashaEventDraft } from "../src/core/akasha/types.js";

describe("Akasha memory traces", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-memory-trace-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("projects a failed tool event into distributed memory traces", () => {
		const failure = event(1, "tool.completed", {
			toolName: "bash",
			isError: true,
			summary: "npm test failed because the package root was wrong",
			path: "packages/coding-agent",
		});

		const traces = buildAkashaMemoryTraces([failure]);
		const kinds = traces.map((trace) => trace.kind);

		expect(kinds).toEqual(expect.arrayContaining(["semantic", "tool", "artifact", "failure", "valence"]));
		expect(traces.find((trace) => trace.kind === "failure")).toMatchObject({
			eventId: failure.eventId,
			key: "bash",
			valence: -0.8,
			cost: 0.75,
		});
		expect(traces.find((trace) => trace.kind === "tool")?.text).toContain("npm test failed");
	});

	it("projects callback completion into callback, success, and closure traces", () => {
		const due = event(1, "time.callback.due", {
			callbackId: "callback-1",
			kind: "promise_due",
			summary: "Review promised validation",
			targetEventId: "promise-1",
		});
		const completed = event(
			2,
			"time.callback.completed",
			{
				callbackId: "callback-1",
				summary: "Promise was resolved after validation",
				targetEventId: "promise-1",
			},
			{ parentEventIds: [due.eventId] },
		);

		const traces = buildAkashaMemoryTraces([due, completed]);
		const completedKinds = traces.filter((trace) => trace.eventId === completed.eventId).map((trace) => trace.kind);

		expect(completedKinds).toEqual(expect.arrayContaining(["callback", "success", "closure", "valence"]));
		expect(traces.find((trace) => trace.eventId === completed.eventId && trace.kind === "closure")).toMatchObject({
			key: "callback-1",
			reward: 0.75,
		});
	});

	it("keeps trace ids deterministic across rebuilds", () => {
		const source = event(
			1,
			"message.user.submitted",
			{ text: "Implement holographic memory traces" },
			{ actor: "user" },
		);

		const first = buildAkashaMemoryTraces([source]);
		const second = buildAkashaMemoryTraces([source]);

		expect(second.map((trace) => trace.traceId)).toEqual(first.map((trace) => trace.traceId));
	});

	it("does not generate traces for suppressed governed events", () => {
		const source = event(1, "message.user.submitted", { text: "temporary preference" }, { actor: "user" });
		const suppressed = materialize(2, createMemoryGovernanceEvent(source, "suppress", "temporary"));

		const traces = buildAkashaMemoryTraces([source, suppressed]);

		expect(traces.some((trace) => trace.eventId === source.eventId)).toBe(false);
		expect(traces.some((trace) => trace.sourceEventIds.includes(source.eventId))).toBe(false);
	});

	it("caches memory traces and rebuilds when the event log changes", () => {
		const store = new JsonlAkashaStore(join(tempDir, "events", "session-1.jsonl"));
		store.append({
			kind: "tool.completed",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "tool",
			subjectId: "bash",
			payload: { toolName: "bash", isError: true, summary: "first failure" },
		});

		const first = buildCachedAkashaMemoryTraces(store, { agentDir: tempDir });
		const second = buildCachedAkashaMemoryTraces(store, { agentDir: tempDir });
		store.append({
			kind: "time.callback.completed",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:01:00.000Z",
			actor: "system",
			payload: { callbackId: "callback-1", summary: "callback closed" },
		});
		const third = buildCachedAkashaMemoryTraces(store, { agentDir: tempDir });

		expect(first.rebuilt).toBe(true);
		expect(second.rebuilt).toBe(false);
		expect(second.freshness.status).toBe("fresh");
		expect(existsSync(second.freshness.cachePath)).toBe(true);
		expect(third.rebuilt).toBe(true);
		expect(third.value.some((trace) => trace.kind === "closure")).toBe(true);
	});
});

function materialize(sequence: number, draft: AkashaEventDraft): AkashaEvent {
	return {
		eventId: `evt-${sequence}`,
		sequence,
		recordedTime: new Date(sequence * 1000).toISOString(),
		version: 1,
		parentEventIds: draft.parentEventIds ?? [],
		payload: draft.payload ?? {},
		importance: draft.importance ?? 0.5,
		ttlPolicy: draft.ttlPolicy ?? "long_term",
		...draft,
	};
}

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
