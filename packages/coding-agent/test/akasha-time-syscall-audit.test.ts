import { describe, expect, it } from "vitest";
import {
	auditAkashaTimeSyscalls,
	createAkashaTimeSyscallRepairedDraft,
	findUnrepairedTimeSyscallMissingAudits,
	parentFallbacksToAudit,
} from "../src/core/akasha/time-syscall-audit.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha time syscall audit", () => {
	it("records missing syscall audits and parents heuristic fallback events to the audit", () => {
		const result = auditAkashaTimeSyscalls(
			event({
				text: "I will run the projection cache tests tomorrow. The build should pass.",
			}),
			{ hasSyscallToolCall: false, mode: "soft" },
		);
		const parented = parentFallbacksToAudit(result.fallbacks, "audit-1");

		expect(result.audit?.kind).toBe("time_syscall.missing");
		expect(result.audit?.payload).toMatchObject({
			status: "missing",
			mode: "soft",
			detectedCount: 2,
		});
		expect(parented.map((draft) => draft.kind)).toEqual(["promise.created", "prediction.made"]);
		expect(parented[0]?.parentEventIds).toEqual(expect.arrayContaining(["audit-1", "assistant-1"]));
		expect(parented[0]?.payload).toMatchObject({ source: "heuristic", auditEventId: "audit-1" });
	});

	it("records satisfied audits when the assistant used an explicit syscall", () => {
		const result = auditAkashaTimeSyscalls(event({ text: "I will create the commitment with a tool." }), {
			hasSyscallToolCall: true,
		});

		expect(result.audit?.kind).toBe("time_syscall.audit");
		expect(result.audit?.payload).toMatchObject({ status: "satisfied" });
		expect(result.fallbacks).toHaveLength(0);
	});

	it("strict mode records missing audits without heuristic fallback commitments", () => {
		const result = auditAkashaTimeSyscalls(event({ text: "I will run the M40 verification tomorrow." }), {
			hasSyscallToolCall: false,
			mode: "strict",
		});

		expect(result.audit?.kind).toBe("time_syscall.missing");
		expect(result.audit?.payload).toMatchObject({
			mode: "strict",
			repairRequired: true,
			detectedCount: 1,
		});
		expect(result.fallbacks).toHaveLength(0);
	});

	it("tracks strict missing syscall repair events", () => {
		const missing = {
			...event({ mode: "strict", repairRequired: true, assistantEventId: "assistant-1" }),
			eventId: "missing-1",
			kind: "time_syscall.missing" as const,
		};
		const assistant = { ...event({ text: "Called akasha_create_commitment." }), eventId: "assistant-2" };
		const repairedDraft = createAkashaTimeSyscallRepairedDraft(missing, assistant);
		const repaired = {
			...event(repairedDraft.payload ?? {}),
			eventId: "repaired-1",
			kind: "time_syscall.repaired" as const,
			sequence: 3,
			recordedTime: "2026-05-12T00:00:03.000Z",
			parentEventIds: repairedDraft.parentEventIds ?? [],
		};

		expect(findUnrepairedTimeSyscallMissingAudits([missing])).toEqual([missing]);
		expect(findUnrepairedTimeSyscallMissingAudits([missing, repaired])).toEqual([]);
		expect(repaired.parentEventIds).toEqual(expect.arrayContaining(["missing-1", "assistant-2"]));
	});
});

function event(payload: Record<string, unknown>): AkashaEvent {
	return {
		eventId: "assistant-1",
		kind: "message.agent.completed",
		sessionId: "session-1",
		streamId: "session:session-1",
		sequence: 1,
		eventTime: "2026-05-12T00:00:00.000Z",
		recordedTime: "2026-05-12T00:00:00.000Z",
		actor: "agent",
		parentEventIds: [],
		payload,
		importance: 0.5,
		ttlPolicy: "long_term",
		version: 1,
	};
}
