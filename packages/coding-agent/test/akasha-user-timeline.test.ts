import { describe, expect, it } from "vitest";
import type { AkashaEvent } from "../src/core/akasha/types.js";
import { buildAkashaUserTimelineFromEvents, summarizeUserTimeline } from "../src/core/akasha/user-timeline.js";

describe("Akasha user timeline", () => {
	it("projects user-level preferences, goals, commitments, predictions, and corrections", () => {
		const timeline = buildAkashaUserTimelineFromEvents([
			event(
				1,
				"message.user.submitted",
				{ text: "长期目标是让时间成为 Agent OS，我希望你不要中断，先写计划再开发。" },
				{ actor: "user" },
			),
			event(2, "preference.inferred", { statement: "User prefers autonomous overnight implementation." }),
			event(3, "promise.created", {
				promiseId: "promise-1",
				summary: "Validate the Akasha action gate before closing",
			}),
			event(4, "prediction.made", {
				predictionId: "prediction-1",
				claim: "The Akasha tests will catch regressions",
				checkAfter: "1970-01-01T00:00:00.000Z",
			}),
			event(5, "prediction.corrected", {
				predictionId: "prediction-2",
				claim: "Build will pass immediately",
				correction: "Build failed on a missing export and needed a follow-up patch",
			}),
		]);

		expect(timeline.longTermGoals.map((item) => item.text)).toContain(
			"长期目标是让时间成为 Agent OS，我希望你不要中断，先写计划再开发。",
		);
		expect(timeline.collaborationHints.map((item) => item.text)).toContain(
			"长期目标是让时间成为 Agent OS，我希望你不要中断，先写计划再开发。",
		);
		expect(timeline.preferences.map((item) => item.text)).toEqual(
			expect.arrayContaining([
				"长期目标是让时间成为 Agent OS，我希望你不要中断，先写计划再开发。",
				"User prefers autonomous overnight implementation.",
			]),
		);
		expect(timeline.openCommitments.map((item) => item.text)).toContain(
			"Validate the Akasha action gate before closing",
		);
		expect(timeline.duePredictions.map((item) => item.text)).toContain("The Akasha tests will catch regressions");
		expect(timeline.corrections.map((item) => item.text)).toContain(
			"Build will pass immediately -> Build failed on a missing export and needed a follow-up patch",
		);
		expect(summarizeUserTimeline(timeline)).toContain("User timeline: 5 events");
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
