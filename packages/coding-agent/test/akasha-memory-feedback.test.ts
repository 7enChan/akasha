import { describe, expect, it } from "vitest";
import { applyAkashaMemoryFeedbackToEdges, buildAkashaMemoryFeedback } from "../src/core/akasha/memory-feedback.js";
import { buildAkashaMemoryTraces } from "../src/core/akasha/memory-trace.js";
import { buildAkashaMemoryTraceEdges } from "../src/core/akasha/memory-trace-edge.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha memory feedback", () => {
	it("raises reinforced recalled traces and lowers weakened or decayed traces", () => {
		const source = event(1, "tool.completed", {
			toolName: "bash",
			isError: true,
			summary: "npm test failed because cwd was wrong",
		});
		const baseTrace = buildAkashaMemoryTraces([source]).find((trace) => trace.kind === "failure");
		expect(baseTrace).toBeDefined();

		const recalled = event(2, "memory.recalled", {
			fieldId: "field-1",
			cueId: "cue-1",
			recalledEventIds: [source.eventId],
			recalledTraceIds: [baseTrace!.traceId],
		});
		const applied = event(3, "memory.applied", {
			recallEventId: recalled.eventId,
			actionType: "tool_call",
		});
		const reinforced = event(4, "memory.reinforced", {
			recallEventId: recalled.eventId,
			appliedEventId: applied.eventId,
			outcomeEventId: "tool-ok",
		});
		const weakened = event(5, "memory.weakened", {
			recallEventId: recalled.eventId,
			appliedEventId: applied.eventId,
			outcomeEventId: "tool-fail",
		});
		const decayed = event(6, "memory.decayed", {
			traceId: baseTrace!.traceId,
			targetEventId: source.eventId,
		});

		const raised = buildAkashaMemoryTraces([source, recalled, applied, reinforced]).find(
			(trace) => trace.traceId === baseTrace!.traceId,
		);
		const lowered = buildAkashaMemoryTraces([source, recalled, applied, weakened, decayed]).find(
			(trace) => trace.traceId === baseTrace!.traceId,
		);

		expect(raised?.recallCount).toBe(1);
		expect(raised?.weight).toBeGreaterThan(baseTrace!.weight);
		expect(lowered?.weight).toBeLessThan(baseTrace!.weight);
	});

	it("projects recall outcomes back onto recalled trace edges", () => {
		const artifact = event(1, "artifact.patched", {
			path: "src/ledger.ts",
			editCount: 1,
		});
		const failure = {
			...event(2, "tool.completed", {
				toolName: "bash",
				isError: true,
				summary: "ledger typecheck failed",
				path: "src/ledger.ts",
			}),
			parentEventIds: [artifact.eventId],
		};
		const traces = buildAkashaMemoryTraces([artifact, failure]);
		const edge = buildAkashaMemoryTraceEdges([artifact, failure], traces).find(
			(candidate) => candidate.kind === "causal_parent",
		);
		expect(edge).toBeDefined();

		const recalled = event(3, "memory.recalled", {
			fieldId: "field-1",
			cueId: "cue-1",
			recalledEventIds: [artifact.eventId, failure.eventId],
			recalledTraceIds: [edge!.fromTraceId, edge!.toTraceId],
			recalledEdgeIds: [edge!.edgeId],
		});
		const reinforced = event(4, "memory.reinforced", {
			recallEventId: recalled.eventId,
			outcomeEventId: "evt-ok",
		});
		const weakened = event(5, "memory.weakened", {
			recallEventId: recalled.eventId,
			outcomeEventId: "evt-fail",
		});
		const decayed = event(6, "memory.decayed", {
			edgeId: edge!.edgeId,
		});

		const raised = applyAkashaMemoryFeedbackToEdges(
			[edge!],
			buildAkashaMemoryFeedback([artifact, failure, recalled, reinforced]),
		)[0];
		const lowered = applyAkashaMemoryFeedbackToEdges(
			[edge!],
			buildAkashaMemoryFeedback([artifact, failure, recalled, weakened, decayed]),
		)[0];

		expect(raised?.weight).toBeGreaterThan(edge!.weight);
		expect(raised?.confidence).toBeGreaterThan(edge!.confidence);
		expect(lowered?.weight).toBeLessThan(edge!.weight);
		expect(lowered?.confidence).toBeLessThan(edge!.confidence);
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
		actor: "system",
		parentEventIds: [],
		payload,
		importance: 0.5,
		ttlPolicy: "long_term",
		version: 1,
	};
}
