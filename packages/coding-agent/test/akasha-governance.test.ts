import { describe, expect, it } from "vitest";
import { exportAkashaEvents, importAkashaEvents } from "../src/core/akasha/event-export.js";
import { applyAkashaRedactions, createRedactionEvent } from "../src/core/akasha/redaction.js";
import { planAkashaRetention } from "../src/core/akasha/retention.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha governance", () => {
	it("plans archive and payload redaction decisions without mutating events", () => {
		const plan = planAkashaRetention(
			[
				event(1, "message.user.submitted", { text: "secret" }, { ttlPolicy: "ephemeral" }),
				event(2, "message.agent.completed", { text: "old" }, { ttlPolicy: "session" }),
				event(3, "memory.crystal.created", { summary: "stable" }, { ttlPolicy: "long_term" }),
			],
			new Date("2026-06-15T00:00:00.000Z"),
		);

		expect(plan.redactPayloadCount).toBe(1);
		expect(plan.archiveCount).toBe(1);
		expect(plan.keepCount).toBe(1);
	});

	it("projects redaction events over sensitive payload fields", () => {
		const target = event(1, "message.user.submitted", { text: "secret", topic: "akasha" });
		const redaction = {
			...createRedactionEvent(target, ["payload.text"], "privacy"),
			eventId: "redaction-1",
			sequence: 2,
			recordedTime: "2026-05-11T00:00:02.000Z",
			parentEventIds: [target.eventId],
			payload: {
				targetEventId: target.eventId,
				fields: ["payload.text"],
				reason: "privacy",
			},
			importance: 0.95,
			ttlPolicy: "permanent" as const,
			version: 1 as const,
		};

		const projected = applyAkashaRedactions([target, redaction]);

		expect(projected[0]?.payload).toEqual({ text: "[redacted]", topic: "akasha" });
		expect(target.payload.text).toBe("secret");
	});

	it("exports and imports JSONL with redactions applied by default", () => {
		const target = event(1, "message.user.submitted", { text: "secret", topic: "akasha" });
		const redaction = {
			...createRedactionEvent(target, ["payload.text"], "privacy"),
			eventId: "redaction-1",
			sequence: 2,
			recordedTime: "2026-05-11T00:00:02.000Z",
			parentEventIds: [target.eventId],
			payload: {
				targetEventId: target.eventId,
				fields: ["payload.text"],
				reason: "privacy",
			},
			importance: 0.95,
			ttlPolicy: "permanent" as const,
			version: 1 as const,
		};

		const content = exportAkashaEvents([redaction, target], { includeRedactionEvents: false });
		const imported = importAkashaEvents(content);

		expect(imported).toHaveLength(1);
		expect(imported[0]?.payload.text).toBe("[redacted]");
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
		ttlPolicy: "session",
		version: 1,
		...overrides,
	};
}
