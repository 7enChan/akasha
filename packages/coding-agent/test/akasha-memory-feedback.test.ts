import { describe, expect, it } from "vitest";
import { buildAkashaMemoryTraces } from "../src/core/akasha/memory-trace.js";
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
