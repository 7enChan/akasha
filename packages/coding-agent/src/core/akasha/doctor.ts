import { collectRedactionTargets } from "./redaction.js";
import { planAkashaRetention } from "./retention.js";
import type { AkashaEvent, AkashaStore } from "./types.js";

export interface AkashaDoctorReport {
	eventCount: number;
	schemaIssueCount: number;
	redactionCount: number;
	retentionArchiveCount: number;
	retentionRedactPayloadCount: number;
	lastEventId?: string;
	lastEventTime?: string;
}

export function buildAkashaDoctorReport(store: AkashaStore, events?: AkashaEvent[]): AkashaDoctorReport {
	const timeline = events ?? store.buildTimeline({ limit: Number.MAX_SAFE_INTEGER });
	const retention = planAkashaRetention(timeline);
	const lastEvent = timeline.at(-1);
	return {
		eventCount: timeline.length,
		schemaIssueCount: schemaIssueCount(store),
		redactionCount: collectRedactionTargets(timeline).length,
		retentionArchiveCount: retention.archiveCount,
		retentionRedactPayloadCount: retention.redactPayloadCount,
		lastEventId: lastEvent?.eventId,
		lastEventTime: lastEvent?.eventTime,
	};
}

function schemaIssueCount(store: AkashaStore): number {
	if ("getSchemaIssueCount" in store && typeof store.getSchemaIssueCount === "function") {
		return store.getSchemaIssueCount() as number;
	}
	return 0;
}
