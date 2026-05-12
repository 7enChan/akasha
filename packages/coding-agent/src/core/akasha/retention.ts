import type { AkashaEvent, AkashaTtlPolicy } from "./types.js";

export type AkashaRetentionAction = "keep" | "archive" | "redact_payload";

export interface AkashaRetentionDecision {
	eventId: string;
	action: AkashaRetentionAction;
	reason: string;
	ttlPolicy: AkashaTtlPolicy;
	eventTime: string;
}

export interface AkashaRetentionPlan {
	decisions: AkashaRetentionDecision[];
	archiveCount: number;
	redactPayloadCount: number;
	keepCount: number;
}

export function planAkashaRetention(events: AkashaEvent[], now: Date = new Date()): AkashaRetentionPlan {
	const decisions = events
		.map((event) => decideRetention(event, now))
		.sort((a, b) => a.eventTime.localeCompare(b.eventTime));
	return {
		decisions,
		archiveCount: decisions.filter((decision) => decision.action === "archive").length,
		redactPayloadCount: decisions.filter((decision) => decision.action === "redact_payload").length,
		keepCount: decisions.filter((decision) => decision.action === "keep").length,
	};
}

function decideRetention(event: AkashaEvent, now: Date): AkashaRetentionDecision {
	const explicitExpiry = typeof event.payload.ttlExpiresAt === "string" ? Date.parse(event.payload.ttlExpiresAt) : NaN;
	if (Number.isFinite(explicitExpiry) && explicitExpiry < now.getTime()) {
		return decision(event, "redact_payload", "explicit ttlExpiresAt has passed");
	}

	const ageDays = (now.getTime() - Date.parse(event.eventTime)) / 86_400_000;
	if (event.ttlPolicy === "ephemeral" && ageDays > 1) {
		return decision(event, "redact_payload", "ephemeral event older than one day");
	}
	if (event.ttlPolicy === "session" && ageDays > 30) {
		return decision(event, "archive", "session event older than thirty days");
	}
	if (event.ttlPolicy === "short_term" && ageDays > 14) {
		return decision(event, "archive", "short-term event older than fourteen days");
	}
	return decision(event, "keep", "within retention policy");
}

function decision(event: AkashaEvent, action: AkashaRetentionAction, reason: string): AkashaRetentionDecision {
	return {
		eventId: event.eventId,
		action,
		reason,
		ttlPolicy: event.ttlPolicy,
		eventTime: event.eventTime,
	};
}
