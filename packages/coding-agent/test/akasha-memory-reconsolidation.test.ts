import { describe, expect, it } from "vitest";
import { deriveAkashaMemoryReconsolidationEvents } from "../src/core/akasha/memory-reconsolidation.js";
import { buildAkashaMemoryTraces } from "../src/core/akasha/memory-trace.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha memory reconsolidation", () => {
	it("derives reconsolidation from a user correction after recall", () => {
		const source = event(1, "failure.lesson_learned", {
			lesson: "Always run tests from repo root",
		});
		const trace = buildAkashaMemoryTraces([source]).find((item) => item.kind === "skill");
		const recalled = event(2, "memory.recalled", {
			fieldId: "field-1",
			cueId: "cue-1",
			recalledEventIds: [source.eventId],
			recalledTraceIds: [trace?.traceId ?? "trace-1"],
			sourceEventIds: [source.eventId],
		});
		const correction = event(3, "message.user.submitted", {
			text: "Actually that is wrong; use the package root for this repo.",
		});

		const drafts = deriveAkashaMemoryReconsolidationEvents([source, recalled, correction]);

		expect(drafts).toHaveLength(1);
		expect(drafts[0]).toMatchObject({
			kind: "memory.reconsolidated",
			objectId: source.eventId,
			payload: {
				oldMemoryEventId: source.eventId,
				newMemoryEventId: correction.eventId,
				reason: "user_correction_after_recall",
			},
		});
	});

	it("lowers the old trace and raises the correction trace after reconsolidation", () => {
		const source = event(1, "failure.lesson_learned", {
			lesson: "Always run tests from repo root",
		});
		const correction = event(2, "message.user.submitted", {
			text: "Actually use the package root for this repo.",
		});
		const reconsolidated = event(3, "memory.reconsolidated", {
			oldMemoryEventId: source.eventId,
			newMemoryEventId: correction.eventId,
			reason: "user_correction_after_recall",
		});

		const baseOld = buildAkashaMemoryTraces([source]).find((trace) => trace.kind === "skill");
		const adjusted = buildAkashaMemoryTraces([source, correction, reconsolidated]);
		const adjustedOld = adjusted.find((trace) => trace.traceId === baseOld?.traceId);
		const adjustedNew = adjusted.find((trace) => trace.eventId === correction.eventId && trace.kind === "semantic");
		const baseNew = buildAkashaMemoryTraces([correction]).find(
			(trace) => trace.eventId === correction.eventId && trace.kind === "semantic",
		);

		expect(adjustedOld?.weight).toBeLessThan(baseOld?.weight ?? 1);
		expect(adjustedNew?.weight).toBeGreaterThan(baseNew?.weight ?? 0);
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
		actor: kind === "message.user.submitted" ? "user" : "system",
		parentEventIds: [],
		payload,
		importance: 0.5,
		ttlPolicy: "long_term",
		version: 1,
	};
}
