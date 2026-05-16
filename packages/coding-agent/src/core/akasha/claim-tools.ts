import { type Static, Type } from "typebox";
import type { AgentToolResult } from "../extensions/types.js";
import {
	type AkashaClaimRecord,
	buildAkashaClaimLedger,
	createAkashaClaimId,
	createAkashaClaimKey,
} from "./claim-ledger.js";
import type { AkashaEvent, AkashaEventDraft, AkashaStore } from "./types.js";

export interface AkashaClaimToolContext {
	store: AkashaStore;
	sessionId: string;
	streamId: string;
	now?: () => string;
	parentEventIds?: string[];
	correlationId?: string;
	toolCallId?: string;
	sourceKeyPrefix?: string;
}

export const recordClaimSchema = Type.Object({
	subject: Type.String(),
	predicate: Type.String(),
	value: Type.String(),
	scope: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	exclusive: Type.Optional(Type.Boolean()),
	confidence: Type.Optional(Type.Number()),
	sourceEventIds: Type.Optional(Type.Array(Type.String())),
});

export type RecordClaimInput = Static<typeof recordClaimSchema>;

export function appendAkashaClaim(ctx: AkashaClaimToolContext, input: RecordClaimInput): AkashaEvent {
	const claimKey = createAkashaClaimKey(input);
	const claimId = createAkashaClaimId(input);
	const summary = normalizeSummary(input);
	const exclusive = input.exclusive ?? false;
	const confidence = clampConfidence(input.confidence ?? 0.75);
	const timeline = ctx.store.buildTimeline({ limit: 1000 });
	const ledger = buildAkashaClaimLedger(timeline);
	const currentClaims = ledger.currentByClaimKey.get(claimKey) ?? [];
	const currentSame = currentClaims.find((claim) => claim.claimId === claimId);
	const conflicting = exclusive ? currentClaims.filter((claim) => claim.claimId !== claimId) : [];
	const existing = ledger.byClaimId.get(claimId);
	const confirmedClaim = currentSame ?? existing;
	const primary = confirmedClaim
		? appendClaimConfirmed(ctx, input, {
				claimId,
				claimKey,
				summary,
				exclusive,
				confidence,
				existing: confirmedClaim,
			})
		: appendClaimObserved(ctx, input, { claimId, claimKey, summary, exclusive, confidence });

	for (const claim of conflicting) {
		appendClaimSuperseded(ctx, claim, primary, input.sourceEventIds ?? []);
	}
	return primary;
}

export function claimToolResult(
	event: AkashaEvent,
): AgentToolResult<{ eventId: string; kind: string; claimId?: string }> {
	return {
		content: [{ type: "text", text: `${event.kind}: ${event.eventId}` }],
		details: {
			eventId: event.eventId,
			kind: event.kind,
			claimId: typeof event.payload.claimId === "string" ? event.payload.claimId : undefined,
		},
	};
}

function appendClaimObserved(
	ctx: AkashaClaimToolContext,
	input: RecordClaimInput,
	claim: {
		claimId: string;
		claimKey: string;
		summary: string;
		exclusive: boolean;
		confidence: number;
	},
): AkashaEvent {
	return ctx.store.append({
		...baseDraft(ctx, "claim.observed", input.sourceEventIds),
		subjectId: "akasha.claim",
		objectId: claim.claimId,
		sourceKey: `${ctx.sourceKeyPrefix ?? "akasha-claim"}:observed:${claim.claimId}`,
		payload: {
			claimId: claim.claimId,
			claimKey: claim.claimKey,
			subject: input.subject,
			predicate: input.predicate,
			value: input.value,
			scope: input.scope,
			summary: claim.summary,
			exclusive: claim.exclusive,
			confidence: claim.confidence,
			source: "tool",
			sourceEventIds: input.sourceEventIds ?? [],
			toolCallId: ctx.toolCallId,
		},
		importance: 0.82,
	});
}

function appendClaimConfirmed(
	ctx: AkashaClaimToolContext,
	input: RecordClaimInput,
	claim: {
		claimId: string;
		claimKey: string;
		summary: string;
		exclusive: boolean;
		confidence: number;
		existing: AkashaClaimRecord;
	},
): AkashaEvent {
	return ctx.store.append({
		...baseDraft(ctx, "claim.confirmed", [claim.existing.latestEventId, ...(input.sourceEventIds ?? [])]),
		subjectId: "akasha.claim",
		objectId: claim.claimId,
		sourceKey: `${ctx.sourceKeyPrefix ?? "akasha-claim"}:confirmed:${claim.claimId}:${
			ctx.toolCallId ?? stableId([claim.existing.latestEventId, ...(input.sourceEventIds ?? [])].join(":"))
		}`,
		payload: {
			claimId: claim.claimId,
			claimKey: claim.claimKey,
			subject: input.subject,
			predicate: input.predicate,
			value: input.value,
			scope: input.scope,
			summary: claim.summary,
			exclusive: claim.exclusive,
			confidence: claim.confidence,
			confirmedEventId: claim.existing.latestEventId,
			source: "tool",
			sourceEventIds: input.sourceEventIds ?? [],
			toolCallId: ctx.toolCallId,
		},
		importance: 0.76,
	});
}

function appendClaimSuperseded(
	ctx: AkashaClaimToolContext,
	oldClaim: AkashaClaimRecord,
	newEvent: AkashaEvent,
	sourceEventIds: string[],
): AkashaEvent {
	const newClaimId = typeof newEvent.payload.claimId === "string" ? newEvent.payload.claimId : newEvent.eventId;
	return ctx.store.append({
		...baseDraft(ctx, "claim.superseded", [oldClaim.latestEventId, newEvent.eventId, ...sourceEventIds]),
		subjectId: "akasha.claim",
		objectId: oldClaim.claimId,
		sourceKey: `${ctx.sourceKeyPrefix ?? "akasha-claim"}:superseded:${oldClaim.claimId}:by:${newClaimId}:${
			newEvent.eventId
		}`,
		parentEventIds: uniqueStrings([oldClaim.latestEventId, newEvent.eventId, ...(ctx.parentEventIds ?? [])]),
		payload: {
			claimId: oldClaim.claimId,
			claimKey: oldClaim.claimKey,
			subject: oldClaim.subject,
			predicate: oldClaim.predicate,
			value: oldClaim.value,
			scope: oldClaim.scope,
			summary: oldClaim.summary,
			exclusive: oldClaim.exclusive,
			supersededByClaimId: newClaimId,
			supersededByEventId: newEvent.eventId,
			reason: "exclusive_claim_replaced",
			sourceEventIds: uniqueStrings([oldClaim.latestEventId, newEvent.eventId, ...sourceEventIds]),
			toolCallId: ctx.toolCallId,
		},
		importance: 0.84,
	});
}

function baseDraft(
	ctx: AkashaClaimToolContext,
	kind: AkashaEventDraft["kind"],
	sourceEventIds: Array<string | undefined> = [],
): AkashaEventDraft {
	return {
		kind,
		sessionId: ctx.sessionId,
		streamId: ctx.streamId,
		eventTime: ctx.now?.() ?? new Date().toISOString(),
		actor: "agent",
		parentEventIds: uniqueStrings([...(ctx.parentEventIds ?? []), ...sourceEventIds]),
		correlationId: ctx.correlationId,
		toolCallId: ctx.toolCallId,
		ttlPolicy: "long_term",
	};
}

function normalizeSummary(input: RecordClaimInput): string {
	const summary = input.summary?.trim();
	if (summary) return summary;
	const scoped = input.scope?.trim() ? ` in ${input.scope.trim()}` : "";
	return `${input.subject.trim()} ${input.predicate.trim()} ${input.value.trim()}${scoped}`;
}

function clampConfidence(value: number): number {
	if (!Number.isFinite(value)) return 0.7;
	return Math.max(0, Math.min(1, value));
}

function stableId(text: string): string {
	let hash = 0;
	for (const char of text) {
		hash = (hash * 31 + char.charCodeAt(0)) | 0;
	}
	return Math.abs(hash).toString(36);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => !!value && value.trim().length > 0))];
}
