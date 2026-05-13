import { deriveAccountabilityEventsFromAssistant } from "./accountability-extractor.js";
import type { AkashaEvent, AkashaEventDraft } from "./types.js";

export interface AkashaTimeSyscallAuditResult {
	audit?: AkashaEventDraft;
	fallbacks: AkashaEventDraft[];
	repair?: AkashaEventDraft;
}

export function auditAkashaTimeSyscalls(
	assistantEvent: AkashaEvent,
	options: {
		hasSyscallToolCall: boolean;
		sourceKeyPrefix?: string;
		mode?: "soft" | "strict";
	} = { hasSyscallToolCall: false },
): AkashaTimeSyscallAuditResult {
	const mode = options.mode ?? "soft";
	const detectedFallbacks = options.hasSyscallToolCall ? [] : deriveAccountabilityEventsFromAssistant(assistantEvent);
	const fallbacks = mode === "strict" ? [] : detectedFallbacks;
	const sourceKeyPrefix = options.sourceKeyPrefix ?? `time-syscall-audit:${assistantEvent.eventId}`;
	if (options.hasSyscallToolCall) {
		return {
			audit: baseAuditDraft(assistantEvent, {
				kind: "time_syscall.audit",
				sourceKey: `${sourceKeyPrefix}:satisfied`,
				payload: {
					status: "satisfied",
					mode,
					assistantEventId: assistantEvent.eventId,
					message: "Assistant used an explicit Akasha time syscall.",
				},
				importance: 0.55,
			}),
			fallbacks,
		};
	}
	if (detectedFallbacks.length === 0) return { fallbacks: [] };
	return {
		audit: baseAuditDraft(assistantEvent, {
			kind: "time_syscall.missing",
			sourceKey: `${sourceKeyPrefix}:missing`,
			payload: {
				status: "missing",
				mode,
				assistantEventId: assistantEvent.eventId,
				detectedCount: detectedFallbacks.length,
				detectedKinds: [...new Set(detectedFallbacks.map((draft) => draft.kind))],
				repairRequired: mode === "strict",
				message: "Assistant expressed future responsibility without an explicit Akasha time syscall.",
			},
			importance: 0.8,
		}),
		fallbacks,
	};
}

export function findUnrepairedTimeSyscallMissingAudits(events: AkashaEvent[]): AkashaEvent[] {
	const repaired = new Set<string>();
	for (const event of events) {
		if (event.kind !== "time_syscall.repaired") continue;
		const missingEventId =
			typeof event.payload.missingEventId === "string" ? event.payload.missingEventId : event.parentEventIds[0];
		if (missingEventId) repaired.add(missingEventId);
	}
	return events.filter(
		(event) =>
			event.kind === "time_syscall.missing" &&
			event.payload.mode === "strict" &&
			event.payload.repairRequired === true &&
			!repaired.has(event.eventId),
	);
}

export function createAkashaTimeSyscallRepairedDraft(
	missingEvent: AkashaEvent,
	assistantEvent: AkashaEvent,
	satisfiedAuditEvent?: AkashaEvent,
): AkashaEventDraft {
	const draft = baseAuditDraft(assistantEvent, {
		kind: "time_syscall.repaired",
		sourceKey: `time-syscall-audit:${assistantEvent.sessionId}:${missingEvent.eventId}:repaired:${assistantEvent.eventId}`,
		payload: {
			status: "repaired",
			mode: "strict",
			missingEventId: missingEvent.eventId,
			assistantEventId: assistantEvent.eventId,
			satisfiedAuditEventId: satisfiedAuditEvent?.eventId,
			message: "A later assistant turn used an explicit Akasha time syscall after a strict missing-syscall audit.",
		},
		importance: 0.82,
	});
	return {
		...draft,
		parentEventIds: [
			...new Set(
				[missingEvent.eventId, assistantEvent.eventId, satisfiedAuditEvent?.eventId].filter(Boolean) as string[],
			),
		],
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
