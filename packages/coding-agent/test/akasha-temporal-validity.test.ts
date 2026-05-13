import { describe, expect, it } from "vitest";
import { buildAkashaActionGateContext } from "../src/core/akasha/action-gate.js";
import {
	deriveAkashaEphemeralStateEventsFromUserMessage,
	detectAkashaEphemeralStates,
} from "../src/core/akasha/ephemeral-state-detector.js";
import { reconstructAkashaMemoryField } from "../src/core/akasha/holographic-memory.js";
import { buildAkashaMemoryCue } from "../src/core/akasha/memory-cue.js";
import { buildAkashaMemoryTraces } from "../src/core/akasha/memory-trace.js";
import {
	buildAkashaTemporalStateLedger,
	formatAkashaTemporalValidityContext,
} from "../src/core/akasha/temporal-state-ledger.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha temporal validity", () => {
	it("detects short-lived health state from user text", () => {
		const detections = detectAkashaEphemeralStates("我今天肚子疼，先休息一下");

		expect(detections).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stateClass: "health_state",
					stateKey: "abdominal_pain",
					currentnessRequired: true,
				}),
			]),
		);
	});

	it("projects observed health state as current, then stale after validity window", () => {
		const user = event(1, "message.user.submitted", "2026-05-10T10:00:00.000Z", {
			text: "我肚子疼",
		});
		const observed = deriveAkashaEphemeralStateEventsFromUserMessage(user, [user]).map((draft, index) =>
			materializeDraft(draft, index + 2),
		);

		const current = buildAkashaTemporalStateLedger([user, ...observed], {
			now: "2026-05-10T12:00:00.000Z",
		});
		const stale = buildAkashaTemporalStateLedger([user, ...observed], {
			now: "2026-05-13T12:00:00.000Z",
		});

		expect(current.current[0]).toMatchObject({ stateClass: "health_state", status: "current" });
		expect(stale.stale[0]).toMatchObject({ stateClass: "health_state", status: "stale" });
		expect(stale.currentnessChecks[0]?.summary).toBe("用户说肚子疼");
		expect(formatAkashaTemporalValidityContext(stale)).toContain("Treat as historical context only");
	});

	it("resolves the latest ephemeral state when user says it is better", () => {
		const user = event(1, "message.user.submitted", "2026-05-10T10:00:00.000Z", {
			text: "我肚子疼",
		});
		const observed = deriveAkashaEphemeralStateEventsFromUserMessage(user, [user]).map((draft, index) =>
			materializeDraft(draft, index + 2),
		);
		const resolvedUser = event(4, "message.user.submitted", "2026-05-13T10:00:00.000Z", {
			text: "已经好了",
		});
		const resolved = deriveAkashaEphemeralStateEventsFromUserMessage(resolvedUser, [
			user,
			...observed,
			resolvedUser,
		]).map((draft, index) => materializeDraft(draft, index + 5));
		const ledger = buildAkashaTemporalStateLedger([user, ...observed, resolvedUser, ...resolved], {
			now: "2026-05-13T12:00:00.000Z",
		});

		expect(resolved[0]?.kind).toBe("state.resolved");
		expect(ledger.resolved[0]).toMatchObject({ stateClass: "health_state", status: "resolved" });
		expect(ledger.currentnessChecks).toHaveLength(0);
	});

	it("injects stale state and currentness checks into Action Gate", () => {
		const user = event(1, "message.user.submitted", "2026-05-10T10:00:00.000Z", {
			text: "我肚子疼",
		});
		const observed = deriveAkashaEphemeralStateEventsFromUserMessage(user, [user]).map((draft, index) =>
			materializeDraft(draft, index + 2),
		);
		const gate = buildAkashaActionGateContext({
			sessionEvents: [user, ...observed],
			now: "2026-05-13T12:00:00.000Z",
		});

		expect(gate?.sections).toContain("temporal_validity");
		expect(gate?.text).toContain("<stale_state>");
		expect(gate?.text).toContain("Before relying on");
		expect(gate?.temporalValidity?.staleHealthStateIds.length).toBe(1);
	});

	it("annotates recalled stale state as historical memory requiring currentness check", () => {
		const user = event(1, "message.user.submitted", "2026-05-10T10:00:00.000Z", {
			text: "我肚子疼",
		});
		const observed = deriveAkashaEphemeralStateEventsFromUserMessage(user, [user]).map((draft, index) =>
			materializeDraft(draft, index + 2),
		);
		const events = [user, ...observed];
		const cue = buildAkashaMemoryCue({
			latestUserText: "继续上次肚子疼那个话题",
			sessionEvents: events,
			now: "2026-05-13T12:00:00.000Z",
		});
		const field = reconstructAkashaMemoryField({
			events,
			traces: buildAkashaMemoryTraces(events),
			cue,
			options: { now: new Date("2026-05-13T12:00:00.000Z") },
		});

		expect(field.validityAnnotations[0]).toMatchObject({
			stateClass: "health_state",
			status: "stale",
			useAs: "requires_currentness_check",
		});
	});
});

function event(
	sequence: number,
	kind: AkashaEvent["kind"],
	eventTime: string,
	payload: Record<string, unknown>,
): AkashaEvent {
	return {
		eventId: `evt-${sequence}`,
		kind,
		sessionId: "session-1",
		streamId: "session:session-1",
		sequence,
		eventTime,
		recordedTime: eventTime,
		actor: kind.startsWith("message.") ? "user" : "system",
		parentEventIds: [],
		payload,
		importance: 0.7,
		ttlPolicy: "long_term",
		version: 1,
	};
}

function materializeDraft(
	draft: ReturnType<typeof deriveAkashaEphemeralStateEventsFromUserMessage>[number],
	sequence: number,
): AkashaEvent {
	return {
		...draft,
		eventId: `evt-${sequence}`,
		sequence,
		recordedTime: draft.eventTime,
		parentEventIds: draft.parentEventIds ?? [],
		payload: draft.payload ?? {},
		importance: draft.importance ?? 0.5,
		ttlPolicy: draft.ttlPolicy ?? "session",
		version: 1,
	};
}
