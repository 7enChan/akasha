import { orderAkashaEvents } from "./ordering.js";
import {
	type AkashaTemporalStateClass,
	type AkashaTemporalStateStatus,
	akashaTemporalValidityWindow,
	computeAkashaExpiresAt,
	computeAkashaTemporalStateStatus,
	computeAkashaValidUntil,
	formatAkashaStateAge,
	isAkashaEphemeralStateClass,
} from "./temporal-validity.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaTemporalStateRecord {
	stateId: string;
	stateClass: AkashaTemporalStateClass;
	stateKey: string;
	summary: string;
	status: AkashaTemporalStateStatus;
	validFrom: string;
	validUntil?: string;
	expiresAt?: string;
	currentnessRequired: boolean;
	confidence: number;
	observedEventId: string;
	latestEventId: string;
	sourceEventIds: string[];
	resolvedEventId?: string;
	resolvedTime?: string;
	supersededEventId?: string;
	supersededByStateId?: string;
	stalenessReason?: string;
}

export interface AkashaTemporalStateLedger {
	now: string;
	states: AkashaTemporalStateRecord[];
	current: AkashaTemporalStateRecord[];
	stale: AkashaTemporalStateRecord[];
	expired: AkashaTemporalStateRecord[];
	resolved: AkashaTemporalStateRecord[];
	superseded: AkashaTemporalStateRecord[];
	currentnessChecks: AkashaTemporalStateRecord[];
}

export function buildAkashaTemporalStateLedger(
	events: AkashaEvent[],
	options: { now?: Date | string } = {},
): AkashaTemporalStateLedger {
	const now = typeof options.now === "string" ? new Date(options.now) : (options.now ?? new Date());
	const records = new Map<string, AkashaTemporalStateRecord>();
	for (const event of orderAkashaEvents(events)) {
		if (!event.kind.startsWith("state.")) continue;
		const stateId = stringPayload(event, "stateId");
		const stateClass = stateClassPayload(event, "stateClass");
		const summary = stringPayload(event, "summary");
		if (!stateId || !stateClass || !summary) continue;
		if (event.kind === "state.observed" || event.kind === "state.confirmed") {
			const stateKey = stringPayload(event, "stateKey") ?? stateId;
			const validFrom = stringPayload(event, "validFrom") ?? event.eventTime;
			const validUntil = stringPayload(event, "validUntil") ?? computeAkashaValidUntil(stateClass, validFrom);
			const expiresAt = stringPayload(event, "expiresAt") ?? computeAkashaExpiresAt(stateClass, validFrom);
			const window = akashaTemporalValidityWindow(stateClass);
			const existing = records.get(stateId);
			records.set(stateId, {
				stateId,
				stateClass,
				stateKey,
				summary,
				status: "current",
				validFrom,
				validUntil,
				expiresAt,
				currentnessRequired: booleanPayload(event, "currentnessRequired") ?? window.currentnessRequired,
				confidence: numberPayload(event, "confidence") ?? existing?.confidence ?? 0.65,
				observedEventId: existing?.observedEventId ?? event.eventId,
				latestEventId: event.eventId,
				sourceEventIds: uniqueStrings([
					...(existing?.sourceEventIds ?? []),
					...stringArrayPayload(event, "sourceEventIds"),
					event.eventId,
				]),
			});
			continue;
		}
		const existing = records.get(stateId);
		const base: AkashaTemporalStateRecord =
			existing ??
			({
				stateId,
				stateClass,
				stateKey: stringPayload(event, "stateKey") ?? stateId,
				summary,
				status: "unknown",
				validFrom: event.eventTime,
				currentnessRequired: akashaTemporalValidityWindow(stateClass).currentnessRequired,
				confidence: numberPayload(event, "confidence") ?? 0.5,
				observedEventId: event.eventId,
				latestEventId: event.eventId,
				sourceEventIds: [],
			} satisfies AkashaTemporalStateRecord);
		const next: AkashaTemporalStateRecord = {
			...base,
			summary,
			latestEventId: event.eventId,
			sourceEventIds: uniqueStrings([
				...base.sourceEventIds,
				...stringArrayPayload(event, "sourceEventIds"),
				event.eventId,
			]),
		};
		if (event.kind === "state.resolved") {
			next.status = "resolved";
			next.resolvedEventId = event.eventId;
			next.resolvedTime = event.eventTime;
		}
		if (event.kind === "state.superseded") {
			next.status = "superseded";
			next.supersededEventId = event.eventId;
			next.supersededByStateId = stringPayload(event, "supersededByStateId");
		}
		if (event.kind === "state.stale") {
			next.status = "stale";
			next.stalenessReason = stringPayload(event, "reason") ?? "materialized_stale_event";
		}
		if (event.kind === "state.expired") {
			next.status = "expired";
			next.stalenessReason = stringPayload(event, "reason") ?? "materialized_expired_event";
		}
		records.set(stateId, next);
	}

	const states = [...records.values()].map((state) => finalizeStateStatus(state, now));
	return {
		now: now.toISOString(),
		states,
		current: states.filter((state) => state.status === "current"),
		stale: states.filter((state) => state.status === "stale"),
		expired: states.filter((state) => state.status === "expired"),
		resolved: states.filter((state) => state.status === "resolved"),
		superseded: states.filter((state) => state.status === "superseded"),
		currentnessChecks: states.filter(
			(state) =>
				state.currentnessRequired &&
				isAkashaEphemeralStateClass(state.stateClass) &&
				(state.status === "stale" || state.status === "expired"),
		),
	};
}

export function formatAkashaTemporalValidityContext(
	ledger: AkashaTemporalStateLedger,
	options: { maxItems?: number } = {},
): string | undefined {
	const maxItems = Math.max(1, Math.floor(options.maxItems ?? 6));
	const current = ledger.current.filter((state) => isAkashaEphemeralStateClass(state.stateClass)).slice(0, maxItems);
	const stale = [...ledger.stale, ...ledger.expired]
		.filter((state) => isAkashaEphemeralStateClass(state.stateClass))
		.slice(0, maxItems);
	const checks = ledger.currentnessChecks.slice(0, maxItems);
	if (current.length === 0 && stale.length === 0 && checks.length === 0) return undefined;
	const now = new Date(ledger.now);
	const lines = ["<akasha_temporal_validity>"];
	if (current.length > 0) {
		lines.push("<current_state>");
		for (const state of current) {
			lines.push(
				`- ${state.stateClass}: ${state.summary} (${formatAkashaStateAge(state.validFrom, now)}, validUntil=${state.validUntil ?? "until_superseded"})`,
			);
		}
		lines.push("</current_state>");
	}
	if (stale.length > 0) {
		lines.push("<stale_state>");
		for (const state of stale) {
			lines.push(
				`- ${state.stateClass}: ${state.summary} (${state.status}, observed ${formatAkashaStateAge(state.validFrom, now)}). Treat as historical context only; do not assume it is current.`,
			);
		}
		lines.push("</stale_state>");
	}
	if (checks.length > 0) {
		lines.push("<currentness_checks>");
		for (const state of checks) {
			const healthSafety =
				state.stateClass === "health_state"
					? " For health states, ask whether it is still present, whether it worsened, and whether urgent symptoms are present; do not diagnose."
					: "";
			lines.push(`- Before relying on "${state.summary}", confirm whether it is still true now.${healthSafety}`);
		}
		lines.push("</currentness_checks>");
	}
	lines.push("</akasha_temporal_validity>");
	return lines.join("\n");
}

export function summarizeAkashaTemporalStateLedger(ledger: AkashaTemporalStateLedger): string {
	const lines = [
		`Temporal states: ${ledger.current.length} current, ${ledger.stale.length} stale, ${ledger.expired.length} expired, ${ledger.resolved.length} resolved`,
		"",
		"Current:",
	];
	appendStateLines(lines, ledger.current);
	lines.push("", "Stale / expired:");
	appendStateLines(lines, [...ledger.stale, ...ledger.expired]);
	lines.push("", "Currentness checks:");
	appendStateLines(lines, ledger.currentnessChecks);
	lines.push("", "Resolved:");
	appendStateLines(lines, ledger.resolved);
	return lines.join("\n");
}

function finalizeStateStatus(state: AkashaTemporalStateRecord, now: Date): AkashaTemporalStateRecord {
	if (state.status === "resolved" || state.status === "superseded") return state;
	const status = computeAkashaTemporalStateStatus({
		stateClass: state.stateClass,
		validUntil: state.validUntil,
		expiresAt: state.expiresAt,
		now,
	});
	return {
		...state,
		status,
		stalenessReason:
			status === "stale"
				? "validity_window_expired"
				: status === "expired"
					? "stale_window_expired"
					: state.stalenessReason,
	};
}

function appendStateLines(lines: string[], states: AkashaTemporalStateRecord[]): void {
	if (states.length === 0) {
		lines.push("- (none)");
		return;
	}
	for (const state of states.slice(0, 12)) {
		const valid = state.validUntil ? ` validUntil=${state.validUntil}` : "";
		lines.push(`- ${state.status} ${state.stateClass} ${state.stateId}: ${state.summary}${valid}`);
	}
}

function stringPayload(event: AkashaEvent, key: string): string | undefined {
	const value = event.payload[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stateClassPayload(event: AkashaEvent, key: string): AkashaTemporalStateClass | undefined {
	const value = stringPayload(event, key);
	return isAkashaTemporalStateClass(value) ? value : undefined;
}

function isAkashaTemporalStateClass(value: string | undefined): value is AkashaTemporalStateClass {
	return (
		value === "health_state" ||
		value === "mood_state" ||
		value === "location_state" ||
		value === "availability_state" ||
		value === "ephemeral_observation" ||
		value === "external_world_fact" ||
		value === "project_state" ||
		value === "preference" ||
		value === "commitment" ||
		value === "prediction"
	);
}

function numberPayload(event: AkashaEvent, key: string): number | undefined {
	const value = event.payload[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanPayload(event: AkashaEvent, key: string): boolean | undefined {
	const value = event.payload[key];
	return typeof value === "boolean" ? value : undefined;
}

function stringArrayPayload(event: AkashaEvent, key: string): string[] {
	const value = event.payload[key];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}
