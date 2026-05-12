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

	it("boosts query matches without dropping time-critical failures", () => {
		const ranked = rankRecallEvents(
			[
				event(1, "message.user.submitted", { text: "unrelated request" }, 0.6),
				event(2, "tool.completed", { toolName: "bash", isError: true, text: "tsc failed" }, 0.95),
				event(3, "artifact.read", { path: "src/payment.ts" }, 0.55),
			],
			"payment",
		);

		expect(ranked[0]?.kind).toBe("tool.completed");
		expect(ranked.map((item) => item.objectId ?? item.payload.path)).toContain("src/payment.ts");
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
		objectId: typeof payload.path === "string" ? payload.path : undefined,
		parentEventIds: [],
		payload,
		importance,
		ttlPolicy: "long_term",
		version: 1,
	};
}
