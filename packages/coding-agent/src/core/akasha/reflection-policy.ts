import type { ResolvedAkashaReflectionSettings } from "../settings-manager.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaReflectionDecision {
	shouldRun: boolean;
	reason: "disabled" | "no_events" | "no_previous_reflection" | "enough_new_events" | "interval_elapsed" | "not_due";
	eventsSinceLastReflection: number;
	lastReflectionEventId?: string;
}

export function decideReflection(
	events: AkashaEvent[],
	settings: ResolvedAkashaReflectionSettings,
	now: Date = new Date(),
): AkashaReflectionDecision {
	if (!settings.enabled) {
		return { shouldRun: false, reason: "disabled", eventsSinceLastReflection: 0 };
	}
	const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
	if (ordered.length === 0) {
		return { shouldRun: false, reason: "no_events", eventsSinceLastReflection: 0 };
	}
	const lastReflection = [...ordered].reverse().find((event) => event.kind === "reflection.completed");
	if (!lastReflection) {
		return {
			shouldRun: true,
			reason: "no_previous_reflection",
			eventsSinceLastReflection: ordered.length,
		};
	}

	const eventsSinceLastReflection = ordered.filter((event) => event.sequence > lastReflection.sequence).length;
	if (eventsSinceLastReflection >= settings.minEventsSinceLastReflection) {
		return {
			shouldRun: true,
			reason: "enough_new_events",
			eventsSinceLastReflection,
			lastReflectionEventId: lastReflection.eventId,
		};
	}

	const elapsedMinutes = (now.getTime() - Date.parse(lastReflection.eventTime)) / 60_000;
	if (elapsedMinutes >= settings.minIntervalMinutes && eventsSinceLastReflection > 0) {
		return {
			shouldRun: true,
			reason: "interval_elapsed",
			eventsSinceLastReflection,
			lastReflectionEventId: lastReflection.eventId,
		};
	}

	return {
		shouldRun: false,
		reason: "not_due",
		eventsSinceLastReflection,
		lastReflectionEventId: lastReflection.eventId,
	};
}
