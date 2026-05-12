import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent, AkashaEventDraft, AkashaEventKind } from "./types.js";

export type AkashaMemoryGovernanceAction = "pin" | "unpin" | "suppress";

export interface AkashaMemoryGovernanceState {
	pinnedEventIds: Set<string>;
	directSuppressedEventIds: Set<string>;
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
	const directSuppressedEventIds = new Set<string>();
	const governanceEvents: AkashaEvent[] = [];
	const ordered = orderAkashaEvents(events);

	for (const event of ordered) {
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
			directSuppressedEventIds.add(targetEventId);
			pinnedEventIds.delete(targetEventId);
		}
	}

	const suppressedEventIds = buildSourceClosure(ordered, directSuppressedEventIds);
	for (const eventId of suppressedEventIds) {
		pinnedEventIds.delete(eventId);
	}

	return { pinnedEventIds, directSuppressedEventIds, suppressedEventIds, governanceEvents };
}

export function filterSuppressedEvents(events: AkashaEvent[]): AkashaEvent[] {
	const ordered = orderAkashaEvents(events);
	const governance = buildMemoryGovernance(ordered);
	if (governance.suppressedEventIds.size === 0) return ordered;
	return ordered.filter((event) => !governance.suppressedEventIds.has(event.eventId));
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

export function buildSourceClosure(events: AkashaEvent[], seedIds: Set<string>): Set<string> {
	const closure = new Set(seedIds);
	if (closure.size === 0) return closure;

	const childrenBySourceId = new Map<string, AkashaEvent[]>();
	for (const event of events) {
		for (const sourceId of sourceEventIds(event)) {
			const children = childrenBySourceId.get(sourceId) ?? [];
			children.push(event);
			childrenBySourceId.set(sourceId, children);
		}
	}

	const queue = [...closure];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const child of childrenBySourceId.get(current) ?? []) {
			if (closure.has(child.eventId)) continue;
			closure.add(child.eventId);
			queue.push(child.eventId);
		}
	}
	return closure;
}

function sourceEventIds(event: AkashaEvent): string[] {
	const ids = new Set<string>(event.parentEventIds);
	addPayloadString(ids, event, "targetEventId");
	addPayloadString(ids, event, "rootEventId");
	addPayloadString(ids, event, "resolverEventId");
	addPayloadStringArray(ids, event, "supportingEventIds");
	addPayloadStringArray(ids, event, "sourceEventIds");
	addPayloadStringArray(ids, event, "eventIds");
	addPayloadStringArray(ids, event, "evidenceEventIds");
	return [...ids].filter((id) => id !== event.eventId);
}

function addPayloadString(ids: Set<string>, event: AkashaEvent, key: string): void {
	const value = event.payload[key];
	if (typeof value === "string" && value.length > 0) ids.add(value);
}

function addPayloadStringArray(ids: Set<string>, event: AkashaEvent, key: string): void {
	const value = event.payload[key];
	if (!Array.isArray(value)) return;
	for (const item of value) {
		if (typeof item === "string" && item.length > 0) ids.add(item);
	}
}
