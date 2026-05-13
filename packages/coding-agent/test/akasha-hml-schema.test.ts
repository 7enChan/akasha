import { describe, expect, it } from "vitest";
import { validateAkashaEventStrict } from "../src/core/akasha/schema.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha HML schema", () => {
	it("requires memory.recalled payload fields", () => {
		const issues = validateAkashaEventStrict(event("memory.recalled", {}));

		expect(issues.map((issue) => issue.message)).toEqual(
			expect.arrayContaining([
				"memory.recalled requires payload.fieldId",
				"memory.recalled requires payload.cueId",
				"memory.recalled requires string[] payload.recalledEventIds",
				"memory.recalled requires string[] payload.recalledTraceIds",
			]),
		);
	});

	it("requires procedure payload source fields", () => {
		const issues = validateAkashaEventStrict(
			event("skill.procedure.created", {
				procedureId: "procedure-1",
				title: "Validate package",
				steps: ["Run tests"],
			}),
		);

		expect(issues.map((issue) => issue.message)).toContain(
			"skill.procedure.created requires string[] payload.sourceEventIds",
		);
	});
});

function event(kind: AkashaEvent["kind"], payload: Record<string, unknown>): AkashaEvent {
	return {
		eventId: "evt-1",
		kind,
		sessionId: "session-1",
		streamId: "session:session-1",
		sequence: 1,
		eventTime: "2026-05-12T00:00:00.000Z",
		recordedTime: "2026-05-12T00:00:00.000Z",
		actor: "system",
		parentEventIds: [],
		payload,
		importance: 0.5,
		ttlPolicy: "long_term",
		version: 1,
	};
}
