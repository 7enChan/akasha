import { buildMemoryGovernance, buildSourceClosure } from "./memory-governance.js";
import { orderAkashaEvents } from "./ordering.js";
import { applyAkashaRedactions, collectRedactionTargets } from "./redaction.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaGovernanceProjection {
	events: AkashaEvent[];
	suppressedEventIds: string[];
	redactedSourceEventIds: string[];
	omittedDerivedEventIds: string[];
}

export function projectAkashaGovernedEvents(events: AkashaEvent[]): AkashaGovernanceProjection {
	const ordered = orderAkashaEvents(events);
	const governance = buildMemoryGovernance(ordered);
	const redactedSourceIds = new Set(collectRedactionTargets(ordered).map((target) => target.targetEventId));
	const redactionClosure = buildSourceClosure(ordered, redactedSourceIds);
	const omittedDerivedIds = new Set(
		[...redactionClosure].filter((eventId) => !redactedSourceIds.has(eventId) && !isRedactionEvent(ordered, eventId)),
	);
	const filtered = ordered.filter(
		(event) => !governance.suppressedEventIds.has(event.eventId) && !omittedDerivedIds.has(event.eventId),
	);

	return {
		events: applyAkashaRedactions(filtered),
		suppressedEventIds: [...governance.suppressedEventIds],
		redactedSourceEventIds: [...redactedSourceIds],
		omittedDerivedEventIds: [...omittedDerivedIds],
	};
}

function isRedactionEvent(events: AkashaEvent[], eventId: string): boolean {
	return events.some((event) => event.eventId === eventId && event.kind === "event.redacted");
}
