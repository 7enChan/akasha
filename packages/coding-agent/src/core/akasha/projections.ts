import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaCausalIndex {
	byId: Map<string, AkashaEvent>;
	childrenByParentId: Map<string, AkashaEvent[]>;
}

export function buildCausalIndex(events: AkashaEvent[]): AkashaCausalIndex {
	const byId = new Map<string, AkashaEvent>();
	const childrenByParentId = new Map<string, AkashaEvent[]>();

	for (const event of events) {
		byId.set(event.eventId, event);
		for (const parentId of event.parentEventIds) {
			const children = childrenByParentId.get(parentId) ?? [];
			children.push(event);
			childrenByParentId.set(parentId, children);
		}
	}

	for (const children of childrenByParentId.values()) {
		children.sort((a, b) => a.sequence - b.sequence);
	}

	return { byId, childrenByParentId };
}

export function findCausalPath(index: AkashaCausalIndex, targetEventId: string): AkashaEvent[] {
	const target = index.byId.get(targetEventId);
	if (!target) return [];

	const path: AkashaEvent[] = [];
	const seen = new Set<string>();
	const visit = (event: AkashaEvent): void => {
		if (seen.has(event.eventId)) return;
		seen.add(event.eventId);
		for (const parentId of event.parentEventIds) {
			const parent = index.byId.get(parentId);
			if (parent) visit(parent);
		}
		path.push(event);
	};

	visit(target);
	return orderAkashaEvents(path);
}

export function findDescendants(index: AkashaCausalIndex, eventId: string): AkashaEvent[] {
	const descendants: AkashaEvent[] = [];
	const seen = new Set<string>();
	const visit = (parentId: string): void => {
		for (const child of index.childrenByParentId.get(parentId) ?? []) {
			if (seen.has(child.eventId)) continue;
			seen.add(child.eventId);
			descendants.push(child);
			visit(child.eventId);
		}
	};

	visit(eventId);
	return orderAkashaEvents(descendants);
}
