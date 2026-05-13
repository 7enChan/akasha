import { createHash } from "node:crypto";

export type AkashaTemporalStateClass =
	| "health_state"
	| "mood_state"
	| "location_state"
	| "availability_state"
	| "ephemeral_observation"
	| "external_world_fact"
	| "project_state"
	| "preference"
	| "commitment"
	| "prediction";

export type AkashaTemporalStateStatus = "current" | "stale" | "expired" | "resolved" | "superseded" | "unknown";

export interface AkashaTemporalValidityWindow {
	validForMs?: number;
	staleForMs?: number;
	currentnessRequired: boolean;
	strategy: "duration" | "until_superseded" | "until_resolved" | "until_checked" | "long_term";
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const DEFAULT_AKASHA_TEMPORAL_VALIDITY: Record<AkashaTemporalStateClass, AkashaTemporalValidityWindow> = {
	health_state: { validForMs: DAY, staleForMs: 6 * DAY, currentnessRequired: true, strategy: "duration" },
	mood_state: { validForMs: 12 * HOUR, staleForMs: 3 * DAY, currentnessRequired: true, strategy: "duration" },
	location_state: { validForMs: 2 * HOUR, staleForMs: DAY, currentnessRequired: true, strategy: "duration" },
	availability_state: { validForMs: 8 * HOUR, staleForMs: 2 * DAY, currentnessRequired: true, strategy: "duration" },
	ephemeral_observation: { validForMs: DAY, staleForMs: 6 * DAY, currentnessRequired: true, strategy: "duration" },
	external_world_fact: { validForMs: DAY, staleForMs: 6 * DAY, currentnessRequired: true, strategy: "duration" },
	project_state: { currentnessRequired: false, strategy: "until_superseded" },
	preference: { currentnessRequired: false, strategy: "long_term" },
	commitment: { currentnessRequired: false, strategy: "until_resolved" },
	prediction: { currentnessRequired: false, strategy: "until_checked" },
};

export function isAkashaEphemeralStateClass(stateClass: AkashaTemporalStateClass): boolean {
	return (
		stateClass === "health_state" ||
		stateClass === "mood_state" ||
		stateClass === "location_state" ||
		stateClass === "availability_state" ||
		stateClass === "ephemeral_observation" ||
		stateClass === "external_world_fact"
	);
}

export function akashaTemporalValidityWindow(stateClass: AkashaTemporalStateClass): AkashaTemporalValidityWindow {
	return DEFAULT_AKASHA_TEMPORAL_VALIDITY[stateClass];
}

export function computeAkashaValidUntil(stateClass: AkashaTemporalStateClass, validFrom: string): string | undefined {
	const window = akashaTemporalValidityWindow(stateClass);
	if (window.strategy !== "duration" || !window.validForMs) return undefined;
	const start = Date.parse(validFrom);
	if (!Number.isFinite(start)) return undefined;
	return new Date(start + window.validForMs).toISOString();
}

export function computeAkashaExpiresAt(stateClass: AkashaTemporalStateClass, validFrom: string): string | undefined {
	const window = akashaTemporalValidityWindow(stateClass);
	if (window.strategy !== "duration" || !window.validForMs || !window.staleForMs) return undefined;
	const start = Date.parse(validFrom);
	if (!Number.isFinite(start)) return undefined;
	return new Date(start + window.validForMs + window.staleForMs).toISOString();
}

export function computeAkashaTemporalStateStatus(input: {
	stateClass: AkashaTemporalStateClass;
	validUntil?: string;
	expiresAt?: string;
	now?: Date;
	terminalStatus?: "resolved" | "superseded";
}): AkashaTemporalStateStatus {
	if (input.terminalStatus) return input.terminalStatus;
	const window = akashaTemporalValidityWindow(input.stateClass);
	if (window.strategy !== "duration") return "current";
	const now = input.now ?? new Date();
	const expiresAt = input.expiresAt ? Date.parse(input.expiresAt) : NaN;
	if (Number.isFinite(expiresAt) && expiresAt < now.getTime()) return "expired";
	const validUntil = input.validUntil ? Date.parse(input.validUntil) : NaN;
	if (Number.isFinite(validUntil) && validUntil < now.getTime()) return "stale";
	return "current";
}

export function createAkashaTemporalStateId(
	stateClass: AkashaTemporalStateClass,
	stateKey: string,
	subject = "user",
): string {
	return `state_${stateClass}_${hashText(`${subject}:${stateClass}:${stateKey}`).slice(0, 20)}`;
}

export function normalizeAkashaTemporalStateKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "_")
		.replace(/[^\w./\-\u4e00-\u9fff]+/gu, "")
		.slice(0, 80);
}

export function formatAkashaStateAge(from: string, now: Date = new Date()): string {
	const start = Date.parse(from);
	if (!Number.isFinite(start)) return "unknown age";
	const ms = Math.max(0, now.getTime() - start);
	if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
	if (ms < DAY) return `${Math.round(ms / HOUR)}h ago`;
	return `${Math.round(ms / DAY)}d ago`;
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
