import { describe, expect, it } from "vitest";
import { createMemoryGovernanceEvent } from "../src/core/akasha/memory-governance.js";
import { buildAkashaMemoryTraces } from "../src/core/akasha/memory-trace.js";
import { buildAkashaMemoryTraceEdges } from "../src/core/akasha/memory-trace-edge.js";
import type { AkashaEvent, AkashaEventDraft } from "../src/core/akasha/types.js";

describe("Akasha memory trace edges", () => {
	it("projects deterministic same-event edges between traces from one event", () => {
		const failure = event(1, "tool.completed", {
			toolName: "bash",
			isError: true,
			summary: "npm test failed in src/foo.ts",
			path: "src/foo.ts",
		});
		const traces = buildAkashaMemoryTraces([failure]);

		const first = buildAkashaMemoryTraceEdges([failure], traces).filter((edge) => edge.kind === "same_event");
		const second = buildAkashaMemoryTraceEdges([failure], traces).filter((edge) => edge.kind === "same_event");

		expect(first.length).toBeGreaterThan(0);
		expect(second.map((edge) => edge.edgeId)).toEqual(first.map((edge) => edge.edgeId));
		expect(first.every((edge) => edge.weight === 0.9 && edge.polarity === "excitatory")).toBe(true);
	});

	it("projects parent-child causal edges", () => {
		const parent = event(1, "message.user.submitted", { text: "Fix src/foo.ts" }, { actor: "user" });
		const child = event(
			2,
			"tool.completed",
			{ toolName: "bash", isError: true, summary: "foo failed", path: "src/foo.ts" },
			{ parentEventIds: [parent.eventId] },
		);
		const traces = buildAkashaMemoryTraces([parent, child]);
		const edges = buildAkashaMemoryTraceEdges([parent, child], traces);

		expect(edges.some((edge) => edge.kind === "causal_parent")).toBe(true);
		expect(
			edges.some(
				(edge) =>
					edge.kind === "causal_parent" &&
					traces.find((trace) => trace.traceId === edge.fromTraceId)?.eventId === parent.eventId &&
					traces.find((trace) => trace.traceId === edge.toTraceId)?.eventId === child.eventId,
			),
		).toBe(true);
	});

	it("projects shared artifact, tool, and callback edges", () => {
		const first = event(1, "tool.completed", {
			toolName: "bash",
			isError: false,
			summary: "read src/foo.ts",
			path: "src/foo.ts",
		});
		const second = event(2, "tool.completed", {
			toolName: "bash",
			isError: true,
			summary: "patch failed in src/foo.ts",
			path: "src/foo.ts",
		});
		const due = event(3, "time.callback.due", {
			callbackId: "callback-1",
			kind: "promise_due",
			summary: "Review callback",
		});
		const completed = event(
			4,
			"time.callback.completed",
			{
				callbackId: "callback-1",
				summary: "Callback closed",
			},
			{ parentEventIds: [due.eventId] },
		);
		const events = [first, second, due, completed];
		const traces = buildAkashaMemoryTraces(events);
		const edges = buildAkashaMemoryTraceEdges(events, traces);
		const kinds = new Set(edges.map((edge) => edge.kind));

		expect(kinds.has("same_artifact")).toBe(true);
		expect(kinds.has("same_tool")).toBe(true);
		expect(kinds.has("same_callback")).toBe(true);
	});

	it("does not produce recallable edges for suppressed source events", () => {
		const source = event(1, "message.user.submitted", { text: "temporary preference" }, { actor: "user" });
		const suppressed = materialize(2, createMemoryGovernanceEvent(source, "suppress", "temporary"));
		const events = [source, suppressed];
		const traces = buildAkashaMemoryTraces(events);
		const edges = buildAkashaMemoryTraceEdges(events, traces);

		expect(traces.some((trace) => trace.eventId === source.eventId)).toBe(false);
		expect(edges.some((edge) => edge.sourceEventIds.includes(source.eventId))).toBe(false);
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
