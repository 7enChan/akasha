import { createHash } from "node:crypto";
import { projectAkashaGovernedEvents } from "./governance-projection.js";
import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent } from "./types.js";

export type AkashaClaimStatus = "current" | "confirmed" | "superseded";

export interface AkashaClaimRecord {
	claimId: string;
	claimKey: string;
	subject: string;
	predicate: string;
	value: string;
	scope?: string;
	summary: string;
	exclusive: boolean;
	confidence: number;
	status: AkashaClaimStatus;
	observedEventId: string;
	latestEventId: string;
	observedTime: string;
	latestEventTime: string;
	sourceEventIds: string[];
	confirmationEventIds: string[];
	supersededEventId?: string;
	supersededTime?: string;
	supersededByClaimId?: string;
	supersededByEventId?: string;
}

export interface AkashaClaimLedger {
	claims: AkashaClaimRecord[];
	current: AkashaClaimRecord[];
	confirmed: AkashaClaimRecord[];
	superseded: AkashaClaimRecord[];
	historical: AkashaClaimRecord[];
	byClaimId: Map<string, AkashaClaimRecord>;
	currentByClaimKey: Map<string, AkashaClaimRecord[]>;
}

export interface AkashaClaimIdentityInput {
	subject: string;
	predicate: string;
	value: string;
	scope?: string;
}

export function buildAkashaClaimLedger(events: AkashaEvent[]): AkashaClaimLedger {
	const claims = new Map<string, AkashaClaimRecord>();
	for (const event of orderAkashaEvents(projectAkashaGovernedEvents(events).events)) {
		if (event.kind === "claim.observed" || event.kind === "claim.confirmed") {
			const claim = claimRecordFromEvent(event, claims.get(stringPayload(event, "claimId") ?? ""));
			if (!claim) continue;
			claims.set(claim.claimId, claim);
			continue;
		}
		if (event.kind === "claim.superseded") {
			const claimId = stringPayload(event, "claimId");
			if (!claimId) continue;
			const existing = claims.get(claimId);
			if (!existing) continue;
			claims.set(claimId, {
				...existing,
				status: "superseded",
				latestEventId: event.eventId,
				latestEventTime: event.eventTime,
				sourceEventIds: uniqueStrings([
					...existing.sourceEventIds,
					...stringArrayPayload(event, "sourceEventIds"),
					event.eventId,
				]),
				supersededEventId: event.eventId,
				supersededTime: event.eventTime,
				supersededByClaimId: stringPayload(event, "supersededByClaimId"),
				supersededByEventId: stringPayload(event, "supersededByEventId"),
			});
		}
	}

	const records = [...claims.values()].sort((a, b) => a.observedTime.localeCompare(b.observedTime));
	const current = records.filter((claim) => claim.status === "current" || claim.status === "confirmed");
	const confirmed = records.filter((claim) => claim.status === "confirmed");
	const superseded = records.filter((claim) => claim.status === "superseded");
	const currentByClaimKey = new Map<string, AkashaClaimRecord[]>();
	for (const claim of current) {
		const existing = currentByClaimKey.get(claim.claimKey) ?? [];
		existing.push(claim);
		currentByClaimKey.set(claim.claimKey, existing);
	}
	return {
		claims: records,
		current,
		confirmed,
		superseded,
		historical: superseded,
		byClaimId: new Map(records.map((claim) => [claim.claimId, claim])),
		currentByClaimKey,
	};
}

export function createAkashaClaimKey(input: Pick<AkashaClaimIdentityInput, "subject" | "predicate" | "scope">): string {
	return [
		normalizeClaimPart(input.subject),
		normalizeClaimPart(input.predicate),
		input.scope ? normalizeClaimPart(input.scope) : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(":");
}

export function createAkashaClaimId(input: AkashaClaimIdentityInput): string {
	const claimKey = createAkashaClaimKey(input);
	return `claim_${hashText(`${claimKey}:${normalizeClaimPart(input.value)}`).slice(0, 24)}`;
}

export function activeAkashaClaimsAt(
	ledger: AkashaClaimLedger,
	eventTime: string,
	options: { exclusiveOnly?: boolean } = {},
): AkashaClaimRecord[] {
	return ledger.claims.filter((claim) => {
		if (options.exclusiveOnly && !claim.exclusive) return false;
		if (claim.observedTime > eventTime) return false;
		if (claim.supersededTime && claim.supersededTime <= eventTime) return false;
		return true;
	});
}

export function claimText(claim: AkashaClaimRecord): string {
	return [claim.subject, claim.predicate, claim.value, claim.scope, claim.summary].filter(Boolean).join(" ");
}

function claimRecordFromEvent(
	event: AkashaEvent,
	existing: AkashaClaimRecord | undefined,
): AkashaClaimRecord | undefined {
	const claimId = stringPayload(event, "claimId");
	const claimKey = stringPayload(event, "claimKey");
	const subject = stringPayload(event, "subject");
	const predicate = stringPayload(event, "predicate");
	const value = stringPayload(event, "value");
	const summary = stringPayload(event, "summary");
	if (!claimId || !claimKey || !subject || !predicate || !value || !summary) return undefined;
	const confirmationEventIds =
		event.kind === "claim.confirmed"
			? uniqueStrings([...(existing?.confirmationEventIds ?? []), event.eventId])
			: (existing?.confirmationEventIds ?? []);
	return {
		claimId,
		claimKey,
		subject,
		predicate,
		value,
		scope: stringPayload(event, "scope"),
		summary,
		exclusive: booleanPayload(event, "exclusive") ?? existing?.exclusive ?? false,
		confidence: numberPayload(event, "confidence") ?? existing?.confidence ?? 0.7,
		status: confirmationEventIds.length > 0 ? "confirmed" : "current",
		observedEventId: existing?.observedEventId ?? event.eventId,
		latestEventId: event.eventId,
		observedTime: existing?.observedTime ?? event.eventTime,
		latestEventTime: event.eventTime,
		sourceEventIds: uniqueStrings([
			...(existing?.sourceEventIds ?? []),
			...stringArrayPayload(event, "sourceEventIds"),
			event.eventId,
		]),
		confirmationEventIds,
	};
}

function normalizeClaimPart(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "_")
		.replace(/[^\w./\-\u4e00-\u9fff]+/gu, "")
		.slice(0, 120);
}

function stringPayload(event: AkashaEvent, key: string): string | undefined {
	const value = event.payload[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayPayload(event: AkashaEvent, key: string): string[] {
	const value = event.payload[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function booleanPayload(event: AkashaEvent, key: string): boolean | undefined {
	const value = event.payload[key];
	return typeof value === "boolean" ? value : undefined;
}

function numberPayload(event: AkashaEvent, key: string): number | undefined {
	const value = event.payload[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.trim()))];
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
