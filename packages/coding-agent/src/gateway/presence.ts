import { createHash } from "node:crypto";
import type { AkashaEvent, AkashaEventDraft } from "../core/akasha/types.js";
import type { AkashaGatewayPlatform } from "./types.js";

export type AkashaGatewayPresenceRole = "gateway" | "device" | "node";
export type AkashaGatewayPresenceStatus = "pending_pairing" | "paired" | "online" | "stale" | "offline" | "blocked";
export type AkashaGatewayPairingAction = "approve" | "reject" | "require_approval";

export interface AkashaGatewayPresenceCapability {
	capabilityId: string;
	description?: string;
	commands?: string[];
	risk?: "low" | "medium" | "high" | "critical";
}

export interface AkashaGatewayPresenceRecord {
	presenceId: string;
	role: AkashaGatewayPresenceRole;
	status: AkashaGatewayPresenceStatus;
	label: string;
	capabilities: AkashaGatewayPresenceCapability[];
	lastSeenAt: string;
	platform?: AkashaGatewayPlatform;
	externalIdHash?: string;
	pairedAt?: string;
	staleAfterMs?: number;
	metadata?: Record<string, string>;
}

export interface AkashaGatewayPresenceIdentityInput {
	role: AkashaGatewayPresenceRole;
	platform?: AkashaGatewayPlatform;
	externalId?: string;
	label?: string;
}

export interface AkashaGatewayPairingInput extends AkashaGatewayPresenceIdentityInput {
	capabilities: AkashaGatewayPresenceCapability[];
	remoteAddress?: string;
	localLoopback?: boolean;
	presentedToken?: string;
	trustedTokens?: string[];
	allowLocalAutoPair?: boolean;
	now?: Date | string;
}

export interface AkashaGatewayPairingDecision {
	action: AkashaGatewayPairingAction;
	reason: string;
	presence: AkashaGatewayPresenceRecord;
}

export interface AkashaGatewayPresenceEventContext {
	sessionId: string;
	streamId: string;
	eventTime?: string;
	parentEventIds?: string[];
	correlationId?: string;
}

export function createAkashaGatewayPresenceId(input: AkashaGatewayPresenceIdentityInput): string {
	const key = stableHash([input.role, input.platform ?? "local", input.externalId ?? input.label ?? "default"]);
	return `gateway-presence:${input.role}:${input.platform ?? "local"}:${key}`;
}

export function createAkashaGatewayIdempotencyKey(scope: string, parts: readonly unknown[]): string {
	return `gateway-idempotency:${sanitizeId(scope)}:${stableHash(parts.map(stablePart))}`;
}

export function decideAkashaGatewayPairing(input: AkashaGatewayPairingInput): AkashaGatewayPairingDecision {
	const now = normalizeNow(input.now ?? new Date()).toISOString();
	const presenceId = createAkashaGatewayPresenceId(input);
	const tokenTrusted =
		typeof input.presentedToken === "string" &&
		input.presentedToken.length > 0 &&
		(input.trustedTokens ?? []).includes(input.presentedToken);
	const localApproved = input.localLoopback === true && input.allowLocalAutoPair === true;
	const hasCapabilities = input.capabilities.length > 0;
	const action: AkashaGatewayPairingAction = !hasCapabilities
		? "reject"
		: tokenTrusted || localApproved
			? "approve"
			: "require_approval";
	const reason =
		action === "reject"
			? "Gateway presence pairing rejected because no capabilities were declared."
			: action === "approve"
				? tokenTrusted
					? "Gateway presence pairing approved by trusted token."
					: "Gateway presence pairing approved for local loopback."
				: "Gateway presence pairing requires explicit approval.";
	return {
		action,
		reason,
		presence: {
			presenceId,
			role: input.role,
			status: action === "approve" ? "paired" : action === "reject" ? "blocked" : "pending_pairing",
			label: input.label ?? presenceId,
			capabilities: input.capabilities,
			lastSeenAt: now,
			platform: input.platform,
			externalIdHash: input.externalId ? stableHash([input.externalId]) : undefined,
			pairedAt: action === "approve" ? now : undefined,
			metadata: input.remoteAddress ? { remoteAddress: input.remoteAddress } : undefined,
		},
	};
}

export function recordAkashaGatewayHeartbeat(
	record: AkashaGatewayPresenceRecord,
	now: Date | string = new Date(),
): AkashaGatewayPresenceRecord {
	const timestamp = normalizeNow(now).toISOString();
	return {
		...record,
		status: record.status === "blocked" ? "blocked" : "online",
		lastSeenAt: timestamp,
	};
}

export function computeAkashaGatewayPresenceStatus(
	record: AkashaGatewayPresenceRecord,
	now: Date | string = new Date(),
	defaultStaleAfterMs = 120_000,
): AkashaGatewayPresenceStatus {
	if (record.status === "blocked" || record.status === "pending_pairing" || record.status === "offline") {
		return record.status;
	}
	const lastSeen = Date.parse(record.lastSeenAt);
	const ageMs = normalizeNow(now).getTime() - lastSeen;
	const staleAfterMs = record.staleAfterMs ?? defaultStaleAfterMs;
	if (!Number.isFinite(lastSeen) || ageMs > staleAfterMs) return "stale";
	return record.status === "paired" ? "paired" : "online";
}

export function createAkashaGatewayPresenceUpdatedDraft(
	context: AkashaGatewayPresenceEventContext,
	record: AkashaGatewayPresenceRecord,
): AkashaEventDraft {
	return {
		kind: "gateway.presence.updated",
		sessionId: context.sessionId,
		streamId: context.streamId,
		eventTime: context.eventTime ?? record.lastSeenAt,
		actor: "system",
		subjectId: record.presenceId,
		parentEventIds: context.parentEventIds,
		correlationId: context.correlationId,
		sourceKey: `gateway-presence:${record.presenceId}:${record.lastSeenAt}:${record.status}`,
		payload: {
			presenceId: record.presenceId,
			role: record.role,
			status: record.status,
			label: record.label,
			platform: record.platform,
			capabilityIds: record.capabilities.map((capability) => capability.capabilityId),
			capabilities: record.capabilities,
			lastSeenAt: record.lastSeenAt,
			externalIdHash: record.externalIdHash,
			pairedAt: record.pairedAt,
			staleAfterMs: record.staleAfterMs,
			metadata: record.metadata,
		},
		importance: record.status === "blocked" ? 0.85 : 0.55,
		ttlPolicy: "long_term",
	};
}

export function projectAkashaGatewayPresence(events: AkashaEvent[]): Map<string, AkashaGatewayPresenceRecord> {
	const records = new Map<string, AkashaGatewayPresenceRecord>();
	for (const event of events) {
		if (event.kind !== "gateway.presence.updated") continue;
		const record = recordFromPresenceEvent(event);
		if (!record) continue;
		const current = records.get(record.presenceId);
		if (!current || record.lastSeenAt.localeCompare(current.lastSeenAt) >= 0) {
			records.set(record.presenceId, record);
		}
	}
	return records;
}

function recordFromPresenceEvent(event: AkashaEvent): AkashaGatewayPresenceRecord | undefined {
	const payload = event.payload;
	const presenceId = stringPayload(payload, "presenceId");
	const role = stringPayload(payload, "role");
	const status = stringPayload(payload, "status");
	const label = stringPayload(payload, "label");
	const lastSeenAt = stringPayload(payload, "lastSeenAt");
	if (!presenceId || !isRole(role) || !isStatus(status) || !label || !lastSeenAt) return undefined;
	return {
		presenceId,
		role,
		status,
		label,
		capabilities: capabilityPayload(payload.capabilities),
		lastSeenAt,
		platform: isPlatform(payload.platform) ? payload.platform : undefined,
		externalIdHash: stringPayload(payload, "externalIdHash"),
		pairedAt: stringPayload(payload, "pairedAt"),
		staleAfterMs: numberPayload(payload, "staleAfterMs"),
		metadata: stringRecordPayload(payload.metadata),
	};
}

function capabilityPayload(value: unknown): AkashaGatewayPresenceCapability[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item.capabilityId !== "string") return [];
		return [
			{
				capabilityId: item.capabilityId,
				description: typeof item.description === "string" ? item.description : undefined,
				commands: stringArray(item.commands),
				risk: isRisk(item.risk) ? item.risk : undefined,
			},
		];
	});
}

function normalizeNow(now: Date | string): Date {
	return now instanceof Date ? now : new Date(now);
}

function stableHash(parts: readonly unknown[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function stablePart(value: unknown): unknown {
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sanitizeId(value: string): string {
	return value.replace(/[^A-Za-z0-9_.:-]+/g, "_");
}

function stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberPayload(payload: Record<string, unknown>, key: string): number | undefined {
	const value = payload[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringRecordPayload(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return items.length > 0 ? items : undefined;
}

function isRole(value: string | undefined): value is AkashaGatewayPresenceRole {
	return value === "gateway" || value === "device" || value === "node";
}

function isStatus(value: string | undefined): value is AkashaGatewayPresenceStatus {
	return (
		value === "pending_pairing" ||
		value === "paired" ||
		value === "online" ||
		value === "stale" ||
		value === "offline" ||
		value === "blocked"
	);
}

function isRisk(value: unknown): value is AkashaGatewayPresenceCapability["risk"] {
	return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function isPlatform(value: unknown): value is AkashaGatewayPlatform {
	return value === "telegram";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
