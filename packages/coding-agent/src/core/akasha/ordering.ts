import type { AkashaEvent } from "./types.js";

export function compareAkashaEvents(a: AkashaEvent, b: AkashaEvent): number {
	return (
		compareIsoTime(a.eventTime, b.eventTime) ||
		compareIsoTime(a.recordedTime, b.recordedTime) ||
		a.sessionId.localeCompare(b.sessionId) ||
		a.sequence - b.sequence ||
		a.eventId.localeCompare(b.eventId)
	);
}

export function orderAkashaEvents(events: AkashaEvent[]): AkashaEvent[] {
	return [...events].sort(compareAkashaEvents);
}

function compareIsoTime(a: string, b: string): number {
	const parsedA = Date.parse(a);
	const parsedB = Date.parse(b);
	if (Number.isFinite(parsedA) && Number.isFinite(parsedB) && parsedA !== parsedB) {
		return parsedA - parsedB;
	}
	return a.localeCompare(b);
}
