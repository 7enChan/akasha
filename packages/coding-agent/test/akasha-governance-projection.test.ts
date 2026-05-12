import { describe, expect, it } from "vitest";
import { projectAkashaGovernedEvents } from "../src/core/akasha/governance-projection.js";
import { createRedactionEvent } from "../src/core/akasha/redaction.js";
import type { AkashaEvent, AkashaEventDraft } from "../src/core/akasha/types.js";

describe("Akasha governance projection", () => {
	it("keeps redacted source events but omits derived facts sourced from them", () => {
		const source = event(1, "message.user.submitted", { text: "private preference" }, { actor: "user" });
		const derived = event(
			2,
			"preference.inferred",
			{ statement: "User prefers private preference", supportingEventIds: [source.eventId] },
			{ parentEventIds: [source.eventId] },
		);
		const redaction = materialize(3, createRedactionEvent(source, ["payload.text"], "privacy"));

		const projection = projectAkashaGovernedEvents([source, derived, redaction]);

		expect(projection.events.map((item) => item.eventId)).toContain(source.eventId);
		expect(projection.events.map((item) => item.eventId)).not.toContain(derived.eventId);
		expect(projection.events.find((item) => item.eventId === source.eventId)?.payload.text).toBe("[redacted]");
		expect(projection.omittedDerivedEventIds).toContain(derived.eventId);
	});
});

function materialize(sequence: number, draft: AkashaEventDraft): AkashaEvent {
	return {
		eventId: `evt-${sequence}`,
		sequence,
		recordedTime: new Date(sequence * 1000).toISOString(),
		version: 1,
		parentEventIds: draft.parentEventIds ?? [],
		payload: draft.payload ?? {},
		importance: draft.importance ?? 0.5,
		ttlPolicy: draft.ttlPolicy ?? "long_term",
		...draft,
	};
}

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
