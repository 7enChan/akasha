import { describe, expect, it } from "vitest";
import { buildMemoryGovernance, createMemoryGovernanceEvent } from "../src/core/akasha/memory-governance.js";
import { createRedactionEvent } from "../src/core/akasha/redaction.js";
import type { AkashaEvent, AkashaEventDraft } from "../src/core/akasha/types.js";
import { buildAkashaUserTimelineFromEvents } from "../src/core/akasha/user-timeline.js";

describe("Akasha memory governance", () => {
	it("tracks pin, unpin, and suppress events append-only", () => {
		const target = event(1, "message.user.submitted", { text: "我希望你先写计划。" }, { actor: "user" });
		const pinned = materialize(2, createMemoryGovernanceEvent(target, "pin", "important"));
		const unpinned = materialize(3, createMemoryGovernanceEvent(target, "unpin", "temporary"));
		const suppressed = materialize(4, createMemoryGovernanceEvent(target, "suppress", "not stable"));

		const governance = buildMemoryGovernance([target, pinned, unpinned, suppressed]);

		expect(governance.pinnedEventIds.has(target.eventId)).toBe(false);
		expect(governance.suppressedEventIds.has(target.eventId)).toBe(true);
		expect(governance.governanceEvents.map((item) => item.kind)).toEqual([
			"memory.pinned",
			"memory.unpinned",
			"memory.suppressed",
		]);
	});

	it("applies suppression and redaction to user timeline projections", () => {
		const stable = event(1, "message.user.submitted", { text: "长期目标是让时间成为 Agent OS。" }, { actor: "user" });
		const sensitive = event(
			2,
			"message.user.submitted",
			{ text: "我希望你记住 secret preference。" },
			{ actor: "user" },
		);
		const pinned = materialize(3, createMemoryGovernanceEvent(stable, "pin", "stable"));
		const redacted = materialize(4, createRedactionEvent(sensitive, ["payload.text"], "privacy"));
		const suppressed = materialize(5, createMemoryGovernanceEvent(sensitive, "suppress", "privacy"));

		const timeline = buildAkashaUserTimelineFromEvents([stable, sensitive, pinned, redacted, suppressed]);

		expect(timeline.longTermGoals).toMatchObject([{ eventId: stable.eventId, pinned: true }]);
		expect(timeline.preferences.map((item) => item.eventId)).not.toContain(sensitive.eventId);
		expect(timeline.suppressedEventIds).toContain(sensitive.eventId);
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
