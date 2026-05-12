import { describe, expect, it } from "vitest";
import { deriveAccountabilityEventsFromAssistant } from "../src/core/akasha/accountability-extractor.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("deriveAccountabilityEventsFromAssistant", () => {
	it("extracts assistant promises with due times", () => {
		const drafts = deriveAccountabilityEventsFromAssistant(
			event(
				1,
				"message.agent.completed",
				{ text: "I will run the build tomorrow. 我会稍后检查失败日志。" },
				{ actor: "agent" },
			),
			{ now: new Date("2026-05-11T00:00:00.000Z") },
		);

		expect(drafts.map((draft) => draft.kind)).toEqual(["promise.created", "promise.created"]);
		expect(drafts[0]?.payload?.summary).toContain("I will run the build tomorrow");
		expect(drafts[0]?.payload?.dueTime).toBe("2026-05-12T00:00:00.000Z");
		expect(drafts[1]?.payload?.summary).toContain("我会稍后检查失败日志");
	});

	it("extracts assistant predictions", () => {
		const drafts = deriveAccountabilityEventsFromAssistant(
			event(1, "message.agent.completed", {
				text: "The focused tests should pass now. 这个补丁应该会修复导出问题。",
			}),
			{ now: new Date("2026-05-11T00:00:00.000Z") },
		);

		expect(drafts.map((draft) => draft.kind)).toEqual(["prediction.made", "prediction.made"]);
		expect(drafts[0]?.payload?.claim).toContain("focused tests should pass");
		expect(drafts[0]?.payload?.checkAfter).toBe("2026-05-12T00:00:00.000Z");
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
		eventTime: "2026-05-11T00:00:00.000Z",
		recordedTime: "2026-05-11T00:00:00.000Z",
		actor: "system",
		parentEventIds: [],
		payload,
		importance: 0.5,
		ttlPolicy: "long_term",
		version: 1,
		...overrides,
	};
}
