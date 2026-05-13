import { createMemoryReconsolidatedDraft } from "./memory-recall-events.js";
import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent, AkashaEventDraft } from "./types.js";

export interface AkashaReconsolidationOptions {
	sessionId?: string;
	streamId?: string;
	eventTime?: string;
	maxDrafts?: number;
}

interface RecallContext {
	event: AkashaEvent;
	sourceEventIds: Set<string>;
}

export function deriveAkashaMemoryReconsolidationEvents(
	events: AkashaEvent[],
	options: AkashaReconsolidationOptions = {},
): AkashaEventDraft[] {
	const ordered = orderAkashaEvents(events);
	const existingKeys = new Set(
		ordered
			.filter((event) => event.kind === "memory.reconsolidated")
			.map((event) =>
				reconsolidationKey(
					stringPayload(event, "reason"),
					stringPayload(event, "oldMemoryEventId"),
					stringPayload(event, "newMemoryEventId"),
				),
			),
	);
	const recalls: RecallContext[] = [];
	const drafts: AkashaEventDraft[] = [];

	for (const event of ordered) {
		if (event.kind === "memory.recalled") {
			recalls.push({
				event,
				sourceEventIds: new Set([
					...stringArrayPayload(event, "recalledEventIds"),
					...stringArrayPayload(event, "sourceEventIds"),
				]),
			});
			continue;
		}

		const candidate = reconsolidationCandidate(event, recalls);
		if (!candidate) continue;
		const key = reconsolidationKey(candidate.reason, candidate.oldMemoryEventId, candidate.newMemoryEventId);
		if (existingKeys.has(key)) continue;
		existingKeys.add(key);
		drafts.push(
			createMemoryReconsolidatedDraft({
				sessionId: options.sessionId ?? event.sessionId,
				streamId: options.streamId ?? event.streamId,
				oldMemoryEventId: candidate.oldMemoryEventId,
				newMemoryEventId: candidate.newMemoryEventId,
				reason: candidate.reason,
				sourceEventIds: [candidate.recall.event.eventId, ...candidate.recall.sourceEventIds, event.eventId],
				parentEventIds: [candidate.recall.event.eventId, event.eventId, candidate.oldMemoryEventId],
				eventTime: options.eventTime ?? event.eventTime,
				sourceKey: `memory-reconsolidation:${key}`,
			}),
		);
	}

	return drafts.slice(-(options.maxDrafts ?? 6));
}

function reconsolidationCandidate(
	event: AkashaEvent,
	recalls: RecallContext[],
):
	| {
			reason: string;
			oldMemoryEventId: string;
			newMemoryEventId: string;
			recall: RecallContext;
	  }
	| undefined {
	if (recalls.length === 0) return undefined;
	if (event.kind === "message.user.submitted" && isCorrectionMessage(event)) {
		const recall = latestRecall(recalls, event);
		const oldMemoryEventId = firstRecallSource(recall);
		if (recall && oldMemoryEventId) {
			return {
				reason: "user_correction_after_recall",
				oldMemoryEventId,
				newMemoryEventId: event.eventId,
				recall,
			};
		}
	}

	if (event.kind === "prediction.corrected") {
		const ids = sourceIds(event);
		const recall = recallIntersecting(recalls, ids) ?? latestRecall(recalls, event);
		const oldMemoryEventId = firstIntersection(recall?.sourceEventIds, ids) ?? firstRecallSource(recall);
		if (recall && oldMemoryEventId) {
			return {
				reason: "prediction_correction_after_recall",
				oldMemoryEventId,
				newMemoryEventId: event.eventId,
				recall,
			};
		}
	}

	if (event.kind === "memory.suppressed" || event.kind === "event.redacted") {
		const targetEventId = stringPayload(event, "targetEventId") ?? event.objectId ?? event.parentEventIds[0];
		const recall = targetEventId ? recallIntersecting(recalls, new Set([targetEventId])) : undefined;
		if (recall && targetEventId) {
			return {
				reason: event.kind === "memory.suppressed" ? "recalled_source_suppressed" : "recalled_source_redacted",
				oldMemoryEventId: targetEventId,
				newMemoryEventId: event.eventId,
				recall,
			};
		}
	}

	return undefined;
}

function latestRecall(recalls: RecallContext[], event: AkashaEvent): RecallContext | undefined {
	return [...recalls].reverse().find((recall) => recall.event.sessionId === event.sessionId);
}

function recallIntersecting(recalls: RecallContext[], ids: Set<string>): RecallContext | undefined {
	return [...recalls].reverse().find((recall) => firstIntersection(recall.sourceEventIds, ids));
}

function firstRecallSource(recall: RecallContext | undefined): string | undefined {
	return recall ? [...recall.sourceEventIds][0] : undefined;
}

function firstIntersection(left: Set<string> | undefined, right: Set<string>): string | undefined {
	if (!left) return undefined;
	for (const id of left) if (right.has(id)) return id;
	return undefined;
}

function sourceIds(event: AkashaEvent): Set<string> {
	const ids = new Set<string>(event.parentEventIds);
	addString(ids, event, "targetEventId");
	addString(ids, event, "rootEventId");
	addString(ids, event, "predictionId");
	addStringArray(ids, event, "sourceEventIds");
	addStringArray(ids, event, "supportingEventIds");
	addStringArray(ids, event, "evidenceEventIds");
	return ids;
}

function isCorrectionMessage(event: AkashaEvent): boolean {
	const text = [stringPayload(event, "text"), stringPayload(event, "summary"), stringPayload(event, "reason")]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	return (
		/\b(wrong|incorrect|actually|correction|correct this|not true|isn't true)\b/.test(text) ||
		/不对|不是|错误|错了|纠正/u.test(text)
	);
}

function reconsolidationKey(reason?: string, oldMemoryEventId?: string, newMemoryEventId?: string): string {
	return `${reason ?? "unknown"}:${oldMemoryEventId ?? "unknown"}:${newMemoryEventId ?? "unknown"}`;
}

function stringPayload(event: AkashaEvent | undefined, key: string): string | undefined {
	const value = event?.payload[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayPayload(event: AkashaEvent | undefined, key: string): string[] {
	const value = event?.payload[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function addString(ids: Set<string>, event: AkashaEvent, key: string): void {
	const value = stringPayload(event, key);
	if (value) ids.add(value);
}

function addStringArray(ids: Set<string>, event: AkashaEvent, key: string): void {
	for (const value of stringArrayPayload(event, key)) ids.add(value);
}
