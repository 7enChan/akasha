import { describe, expect, it } from "vitest";
import { createCrystalDrafts } from "../src/core/akasha/crystals.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha crystals", () => {
	it("creates a failure lesson from repeated same-tool failures", () => {
		const drafts = createCrystalDrafts(
			[
				event(
					1,
					"tool.completed",
					{ toolName: "bash", isError: true, text: "npm test failed" },
					{ objectId: "bash" },
				),
				event(
					2,
					"tool.completed",
					{ toolName: "bash", isError: true, text: "npm test failed again" },
					{
						objectId: "bash",
					},
				),
			],
			"session-1",
			"session:session-1",
		);

		expect(drafts.map((draft) => draft.kind)).toContain("failure.lesson_learned");
		expect(drafts[0]?.payload?.kind).toBe("failure_lesson");
		expect(drafts[0]?.payload?.supportingEventIds).toEqual(["evt-1", "evt-2"]);
	});

	it("creates a preference crystal seed from user preference language", () => {
		const drafts = createCrystalDrafts(
			[event(1, "message.user.submitted", { text: "我希望后续都先跑 focused tests" }, { actor: "user" })],
			"session-1",
			"session:session-1",
		);

		expect(drafts.map((draft) => draft.kind)).toContain("preference.inferred");
		expect(drafts[0]?.payload?.supportingEventIds).toEqual(["evt-1"]);
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
