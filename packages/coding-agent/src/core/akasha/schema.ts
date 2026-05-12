import type { AkashaActor, AkashaEvent, AkashaEventKind, AkashaTtlPolicy } from "./types.js";

export const CURRENT_AKASHA_EVENT_VERSION = 1 as const;

export interface AkashaSchemaIssue {
	line?: number;
	eventId?: string;
	code: "invalid_json" | "invalid_shape" | "unsupported_version";
	message: string;
}

export interface AkashaSchemaParseResult {
	events: AkashaEvent[];
	issues: AkashaSchemaIssue[];
}

export function parseAkashaJsonl(content: string): AkashaSchemaParseResult {
	const events: AkashaEvent[] = [];
	const issues: AkashaSchemaIssue[] = [];
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line?.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			const migrated = migrateAkashaEvent(parsed);
			if (migrated) {
				events.push(migrated);
			} else {
				issues.push({
					line: index + 1,
					code: "invalid_shape",
					message: "Line does not contain a valid Akasha event",
				});
			}
		} catch (error) {
			issues.push({
				line: index + 1,
				code: "invalid_json",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { events, issues };
}

export function migrateAkashaEvent(value: unknown): AkashaEvent | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version !== undefined && value.version !== CURRENT_AKASHA_EVENT_VERSION) {
		return undefined;
	}
	if (
		typeof value.eventId !== "string" ||
		typeof value.kind !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.streamId !== "string" ||
		typeof value.sequence !== "number" ||
		typeof value.eventTime !== "string" ||
		typeof value.recordedTime !== "string" ||
		typeof value.actor !== "string" ||
		!Array.isArray(value.parentEventIds)
	) {
		return undefined;
	}

	const payload = isRecord(value.payload) ? value.payload : {};
	return {
		eventId: value.eventId,
		kind: value.kind as AkashaEventKind,
		sessionId: value.sessionId,
		streamId: value.streamId,
		sequence: value.sequence,
		eventTime: value.eventTime,
		recordedTime: value.recordedTime,
		actor: value.actor as AkashaActor,
		subjectId: typeof value.subjectId === "string" ? value.subjectId : undefined,
		objectId: typeof value.objectId === "string" ? value.objectId : undefined,
		toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
		sourceKey: typeof value.sourceKey === "string" ? value.sourceKey : undefined,
		parentEventIds: value.parentEventIds.filter((item): item is string => typeof item === "string"),
		correlationId: typeof value.correlationId === "string" ? value.correlationId : undefined,
		payload,
		importance: typeof value.importance === "number" ? value.importance : 0.5,
		ttlPolicy: isTtlPolicy(value.ttlPolicy) ? value.ttlPolicy : "session",
		version: CURRENT_AKASHA_EVENT_VERSION,
	};
}

export function validateAkashaEvent(value: unknown): value is AkashaEvent {
	return migrateAkashaEvent(value) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTtlPolicy(value: unknown): value is AkashaTtlPolicy {
	return (
		value === "ephemeral" ||
		value === "session" ||
		value === "short_term" ||
		value === "long_term" ||
		value === "permanent"
	);
}
