import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent, AkashaEventDraft } from "./types.js";

export interface AkashaCrystalPayload {
	kind: "preference" | "failure_lesson" | "workflow" | "pattern";
	statement: string;
	timeRange: { from: string; to: string };
	supportingEventIds: string[];
	sourceEventIds: string[];
	confidence: number;
	expiresAt?: string;
}

export function createCrystalDrafts(events: AkashaEvent[], sessionId: string, streamId: string): AkashaEventDraft[] {
	const ordered = orderAkashaEvents(events);
	const drafts: AkashaEventDraft[] = [];
	drafts.push(...createFailureLessonDrafts(ordered, sessionId, streamId));
	drafts.push(...createPreferenceDrafts(ordered, sessionId, streamId));
	return drafts;
}

export function toMemoryCrystalDraft(
	crystalEvent: AkashaEvent,
	sourceKeySuffix = crystalEvent.eventId,
): AkashaEventDraft {
	return {
		kind: "memory.crystal.created",
		sessionId: crystalEvent.sessionId,
		streamId: crystalEvent.streamId,
		eventTime: crystalEvent.eventTime,
		actor: "system",
		subjectId: "akasha",
		objectId: typeof crystalEvent.payload.kind === "string" ? crystalEvent.payload.kind : crystalEvent.kind,
		sourceKey: `memory-crystal:${sourceKeySuffix}`,
		parentEventIds: [crystalEvent.eventId],
		payload: {
			...crystalEvent.payload,
			sourceEventKind: crystalEvent.kind,
			sourceEventId: crystalEvent.eventId,
			sourceEventIds: crystalSourceEventIds(crystalEvent),
		},
		importance: Math.max(0.75, crystalEvent.importance),
		ttlPolicy: "long_term",
	};
}

function createFailureLessonDrafts(events: AkashaEvent[], sessionId: string, streamId: string): AkashaEventDraft[] {
	const failuresByKey = new Map<string, AkashaEvent[]>();
	for (const event of events) {
		if (event.kind !== "tool.completed" || event.payload.isError !== true) continue;
		const key = typeof event.payload.toolName === "string" ? event.payload.toolName : (event.objectId ?? "tool");
		const failures = failuresByKey.get(key) ?? [];
		failures.push(event);
		failuresByKey.set(key, failures);
	}

	const drafts: AkashaEventDraft[] = [];
	for (const [toolName, failures] of failuresByKey) {
		if (failures.length < 2) continue;
		const first = failures[0]!;
		const last = failures[failures.length - 1]!;
		const payload: AkashaCrystalPayload = {
			kind: "failure_lesson",
			statement: `${toolName} failed ${failures.length} times in this session; check assumptions and command setup before retrying.`,
			timeRange: { from: first.eventTime, to: last.eventTime },
			supportingEventIds: failures.map((event) => event.eventId),
			sourceEventIds: failures.map((event) => event.eventId),
			confidence: Math.min(0.95, 0.55 + failures.length * 0.1),
		};
		drafts.push({
			kind: "failure.lesson_learned",
			sessionId,
			streamId,
			eventTime: last.eventTime,
			actor: "system",
			subjectId: "akasha",
			objectId: toolName,
			sourceKey: `failure-lesson:${toolName}:${failures.map((event) => event.eventId).join(",")}`,
			parentEventIds: failures.map((event) => event.eventId),
			payload: payload as unknown as Record<string, unknown>,
			importance: 0.9,
			ttlPolicy: "long_term",
		});
	}
	return drafts;
}

function createPreferenceDrafts(events: AkashaEvent[], sessionId: string, streamId: string): AkashaEventDraft[] {
	const preferenceEvents = events.filter(
		(event) => event.kind === "message.user.submitted" && looksLikePreference(payloadText(event)),
	);
	if (preferenceEvents.length === 0) return [];
	const last = preferenceEvents[preferenceEvents.length - 1]!;
	const payload: AkashaCrystalPayload = {
		kind: "preference",
		statement: `User stated a preference: ${payloadText(last)}`,
		timeRange: { from: preferenceEvents[0]!.eventTime, to: last.eventTime },
		supportingEventIds: [last.eventId],
		sourceEventIds: [last.eventId],
		confidence: 0.65,
	};
	return [
		{
			kind: "preference.inferred",
			sessionId,
			streamId,
			eventTime: last.eventTime,
			actor: "system",
			subjectId: "akasha",
			objectId: "user.preference",
			sourceKey: `preference-inferred:${last.eventId}`,
			parentEventIds: [last.eventId],
			payload: payload as unknown as Record<string, unknown>,
			importance: 0.75,
			ttlPolicy: "long_term",
		},
	];
}

function payloadText(event: AkashaEvent): string {
	if (typeof event.payload.text === "string") return event.payload.text;
	if (typeof event.payload.summary === "string") return event.payload.summary;
	return "";
}

function crystalSourceEventIds(crystalEvent: AkashaEvent): string[] {
	const sourceIds = crystalEvent.payload.sourceEventIds;
	if (Array.isArray(sourceIds)) return sourceIds.filter((item): item is string => typeof item === "string");
	const supportingIds = crystalEvent.payload.supportingEventIds;
	if (Array.isArray(supportingIds)) return supportingIds.filter((item): item is string => typeof item === "string");
	return crystalEvent.parentEventIds;
}

function looksLikePreference(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		lower.includes("prefer") ||
		lower.includes("i like") ||
		lower.includes("i want") ||
		text.includes("我喜欢") ||
		text.includes("我希望") ||
		text.includes("偏好")
	);
}
