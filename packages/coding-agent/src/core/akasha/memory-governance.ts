import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent, AkashaEventDraft, AkashaEventKind } from "./types.js";

export type AkashaMemoryGovernanceAction = "pin" | "unpin" | "suppress";

export interface AkashaMemoryGovernanceState {
	pinnedEventIds: Set<string>;
	suppressedEventIds: Set<string>;
	governanceEvents: AkashaEvent[];
}

export function createMemoryGovernanceEvent(
	target: AkashaEvent,
	action: AkashaMemoryGovernanceAction,
	reason = "user_requested",
): AkashaEventDraft {
	const kind = memoryGovernanceKind(action);
	return {
		kind,
		sessionId: target.sessionId,
		streamId: target.streamId,
		eventTime: new Date().toISOString(),
		actor: "user",
		subjectId: "akasha.memory_governance",
		objectId: target.eventId,
		sourceKey: `memory-governance:${action}:${target.eventId}:${reason}`,
		parentEventIds: [target.eventId],
		payload: {
			targetEventId: target.eventId,
			action,
			reason,
		},
		importance: 0.95,
		ttlPolicy: "permanent",
	};
}

export function buildMemoryGovernance(events: AkashaEvent[]): AkashaMemoryGovernanceState {
	const pinnedEventIds = new Set<string>();
	const suppressedEventIds = new Set<string>();
	const governanceEvents: AkashaEvent[] = [];

	for (const event of orderAkashaEvents(events)) {
		if (!isMemoryGovernanceEvent(event)) continue;
		governanceEvents.push(event);
		const targetEventId = targetFromEvent(event);
		if (!targetEventId) continue;
		if (event.kind === "memory.pinned") {
			pinnedEventIds.add(targetEventId);
		}
		if (event.kind === "memory.unpinned") {
			pinnedEventIds.delete(targetEventId);
		}
		if (event.kind === "memory.suppressed") {
			suppressedEventIds.add(targetEventId);
			pinnedEventIds.delete(targetEventId);
		}
	}

	return { pinnedEventIds, suppressedEventIds, governanceEvents };
}

export function isMemoryGovernanceEvent(event: AkashaEvent): boolean {
	return event.kind === "memory.pinned" || event.kind === "memory.unpinned" || event.kind === "memory.suppressed";
}

function memoryGovernanceKind(action: AkashaMemoryGovernanceAction): AkashaEventKind {
	if (action === "pin") return "memory.pinned";
	if (action === "unpin") return "memory.unpinned";
	return "memory.suppressed";
}

function targetFromEvent(event: AkashaEvent): string | undefined {
	return typeof event.payload.targetEventId === "string"
		? event.payload.targetEventId
		: (event.objectId ?? event.parentEventIds[0]);
}
