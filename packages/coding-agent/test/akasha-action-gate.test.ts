import { describe, expect, it } from "vitest";
import { buildAkashaActionGateContext } from "../src/core/akasha/action-gate.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";
import { buildAkashaUserTimelineFromEvents } from "../src/core/akasha/user-timeline.js";

describe("Akasha action gate", () => {
	it("builds a compact pre-action control context from temporal facts", () => {
		const events = [
			event(
				1,
				"message.user.submitted",
				{ text: "Refactor Akasha so time controls agent actions." },
				{ actor: "user" },
			),
			event(
				2,
				"artifact.patched",
				{ path: "src/core/akasha/action-gate.ts", isError: false },
				{
					objectId: "src/core/akasha/action-gate.ts",
				},
			),
			event(3, "loop.opened", {
				loopKey: "evt-2:artifact_changed_without_validation",
				rootEventId: "evt-2",
				reason: "artifact_changed_without_validation",
				summary: "src/core/akasha/action-gate.ts changed without validation",
				state: "open",
			}),
			event(4, "message.user.submitted", { text: "我希望你自主决策，不要中断。" }, { actor: "user" }),
			event(5, "promise.created", {
				promiseId: "promise-1",
				summary: "Run Akasha tests before final response",
			}),
			event(6, "prediction.corrected", {
				predictionId: "prediction-1",
				claim: "The first build will pass",
				correction: "The build needed one more export fix",
			}),
		];

		const gate = buildAkashaActionGateContext({
			sessionEvents: events,
			userTimeline: buildAkashaUserTimelineFromEvents(events),
		});

		expect(gate?.text).toContain("<akasha_action_gate>");
		expect(gate?.text).toContain("Current project goal: 我希望你自主决策，不要中断。");
		expect(gate?.text).toContain("src/core/akasha/action-gate.ts");
		expect(gate?.text).toContain("Open loops:");
		expect(gate?.text).toContain("Open commitments:");
		expect(gate?.text).toContain("User preferences:");
		expect(gate?.text).toContain("Collaboration hints:");
		expect(gate?.text).toContain("Prior corrections:");
		expect(gate?.text).toContain("Operating policy:");
		expect(gate?.eventIds).toEqual(expect.arrayContaining(["evt-2", "evt-3", "evt-4", "evt-5", "evt-6"]));
	});

	it("does not emit a gate when no temporal control facts exist", () => {
		expect(buildAkashaActionGateContext({ sessionEvents: [] })).toBeUndefined();
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
