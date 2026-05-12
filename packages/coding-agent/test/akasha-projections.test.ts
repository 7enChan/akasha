import { describe, expect, it } from "vitest";
import { buildCausalIndex, findCausalPath, findDescendants } from "../src/core/akasha/projections.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha projections", () => {
	it("builds a causal index and finds a root-to-target path", () => {
		const root = event("root", 1, []);
		const child = event("child", 2, ["root"]);
		const leaf = event("leaf", 3, ["child"]);
		const index = buildCausalIndex([leaf, child, root]);

		expect(findCausalPath(index, "leaf").map((item) => item.eventId)).toEqual(["root", "child", "leaf"]);
		expect(findDescendants(index, "root").map((item) => item.eventId)).toEqual(["child", "leaf"]);
	});
});

function event(eventId: string, sequence: number, parentEventIds: string[]): AkashaEvent {
	return {
		eventId,
		kind: "message.user.submitted",
		sessionId: "session-1",
		streamId: "session:session-1",
		sequence,
		eventTime: new Date(sequence * 1000).toISOString(),
		recordedTime: new Date(sequence * 1000).toISOString(),
		actor: "user",
		parentEventIds,
		payload: { text: eventId },
		importance: 0.5,
		ttlPolicy: "long_term",
		version: 1,
	};
}
