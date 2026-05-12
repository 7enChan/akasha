import { deriveAccountabilityEventsFromAssistant } from "./accountability-extractor.js";
import type { AkashaEvent, AkashaEventDraft } from "./types.js";

export interface AkashaTimeSyscallAuditResult {
	audit?: AkashaEventDraft;
	fallbacks: AkashaEventDraft[];
}

export function auditAkashaTimeSyscalls(
	assistantEvent: AkashaEvent,
	options: {
		hasSyscallToolCall: boolean;
		sourceKeyPrefix?: string;
		mode?: "soft" | "strict";
	} = { hasSyscallToolCall: false },
): AkashaTimeSyscallAuditResult {
	const fallbacks = options.hasSyscallToolCall ? [] : deriveAccountabilityEventsFromAssistant(assistantEvent);
	const sourceKeyPrefix = options.sourceKeyPrefix ?? `time-syscall-audit:${assistantEvent.eventId}`;
	if (options.hasSyscallToolCall) {
		return {
			audit: baseAuditDraft(assistantEvent, {
				kind: "time_syscall.audit",
				sourceKey: `${sourceKeyPrefix}:satisfied`,
				payload: {
					status: "satisfied",
					mode: options.mode ?? "soft",
					assistantEventId: assistantEvent.eventId,
					message: "Assistant used an explicit Akasha time syscall.",
				},
				importance: 0.55,
			}),
			fallbacks,
		};
	}
	if (fallbacks.length === 0) return { fallbacks };
	return {
		audit: baseAuditDraft(assistantEvent, {
			kind: "time_syscall.missing",
			sourceKey: `${sourceKeyPrefix}:missing`,
			payload: {
				status: "missing",
				mode: options.mode ?? "soft",
				assistantEventId: assistantEvent.eventId,
				detectedCount: fallbacks.length,
				detectedKinds: [...new Set(fallbacks.map((draft) => draft.kind))],
				message: "Assistant expressed future responsibility without an explicit Akasha time syscall.",
			},
			importance: 0.8,
		}),
		fallbacks,
	};
}

export function parentFallbacksToAudit(
	fallbacks: AkashaEventDraft[],
	auditEventId: string | undefined,
): AkashaEventDraft[] {
	if (!auditEventId) return fallbacks;
	return fallbacks.map((draft) => ({
		...draft,
		parentEventIds: [...new Set([auditEventId, ...(draft.parentEventIds ?? [])])],
		payload: {
			...draft.payload,
			source: "heuristic",
			confidence: typeof draft.payload?.confidence === "number" ? draft.payload.confidence : 0.55,
			auditEventId,
		},
	}));
}

function baseAuditDraft(
	assistantEvent: AkashaEvent,
	options: {
		kind: "time_syscall.audit" | "time_syscall.missing" | "time_syscall.repaired";
		sourceKey: string;
		payload: Record<string, unknown>;
		importance: number;
	},
): AkashaEventDraft {
	return {
		kind: options.kind,
		sessionId: assistantEvent.sessionId,
		streamId: assistantEvent.streamId,
		eventTime: assistantEvent.eventTime,
		actor: "system",
		subjectId: "akasha.time_syscall_audit",
		objectId: assistantEvent.eventId,
		sourceKey: options.sourceKey,
		parentEventIds: [assistantEvent.eventId],
		correlationId: assistantEvent.correlationId,
		payload: options.payload,
		importance: options.importance,
		ttlPolicy: "long_term",
	};
}
