import { type Static, Type } from "typebox";
import type { AgentToolResult } from "../extensions/types.js";
import type { AkashaEvent, AkashaEventDraft, AkashaStore } from "./types.js";

export const AKASHA_TIME_SYSCALL_TOOL_NAMES = [
	"akasha_create_commitment",
	"akasha_resolve_commitment",
	"akasha_create_prediction",
	"akasha_check_prediction",
] as const;

export type AkashaTimeSyscallToolName = (typeof AKASHA_TIME_SYSCALL_TOOL_NAMES)[number];

export interface AkashaTimeSyscallContext {
	store: AkashaStore;
	sessionId: string;
	streamId: string;
	now?: () => string;
	parentEventIds?: string[];
	correlationId?: string;
	toolCallId?: string;
	sourceKeyPrefix?: string;
}

export const createCommitmentSchema = Type.Object({
	summary: Type.String(),
	dueTime: Type.Optional(Type.String()),
	resolutionCriteria: Type.Optional(Type.String()),
	confidence: Type.Optional(Type.Number()),
	sourceEventIds: Type.Optional(Type.Array(Type.String())),
});

export const resolveCommitmentSchema = Type.Object({
	promiseId: Type.String(),
	resolution: Type.Optional(Type.String()),
	evidenceEventId: Type.Optional(Type.String()),
});

export const createPredictionSchema = Type.Object({
	claim: Type.String(),
	checkAfter: Type.Optional(Type.String()),
	confidence: Type.Optional(Type.Number()),
	resolutionCriteria: Type.Optional(Type.String()),
	sourceEventIds: Type.Optional(Type.Array(Type.String())),
});

export const checkPredictionSchema = Type.Object({
	predictionId: Type.String(),
	actual: Type.String(),
	correct: Type.Optional(Type.Boolean()),
	correction: Type.Optional(Type.String()),
	evidenceEventId: Type.Optional(Type.String()),
});

export type CreateCommitmentInput = Static<typeof createCommitmentSchema>;
export type ResolveCommitmentInput = Static<typeof resolveCommitmentSchema>;
export type CreatePredictionInput = Static<typeof createPredictionSchema>;
export type CheckPredictionInput = Static<typeof checkPredictionSchema>;

export function appendAkashaCommitment(ctx: AkashaTimeSyscallContext, input: CreateCommitmentInput): AkashaEvent {
	const promiseId = `promise:syscall:${ctx.toolCallId ?? stableId(input.summary)}`;
	return ctx.store.append({
		...baseDraft(ctx, "promise.created", input.sourceEventIds),
		subjectId: "akasha.time_syscall",
		objectId: input.summary,
		sourceKey: `${ctx.sourceKeyPrefix ?? "akasha-syscall"}:commitment:${ctx.toolCallId ?? stableId(input.summary)}`,
		payload: {
			promiseId,
			summary: input.summary,
			dueTime: input.dueTime,
			resolutionCriteria: input.resolutionCriteria,
			confidence: clampConfidence(input.confidence ?? 0.9),
			source: "syscall",
			sourceEventIds: input.sourceEventIds ?? [],
			toolCallId: ctx.toolCallId,
		},
		importance: 0.9,
	});
}

export function appendAkashaCommitmentResolution(
	ctx: AkashaTimeSyscallContext,
	input: ResolveCommitmentInput,
): AkashaEvent {
	return ctx.store.append({
		...baseDraft(ctx, "promise.resolved", [input.promiseId, input.evidenceEventId]),
		subjectId: "akasha.time_syscall",
		objectId: input.promiseId,
		sourceKey: `${ctx.sourceKeyPrefix ?? "akasha-syscall"}:commitment-resolved:${input.promiseId}:${
			ctx.toolCallId ?? "manual"
		}`,
		payload: {
			promiseId: input.promiseId,
			resolution: input.resolution ?? "resolved",
			evidenceEventId: input.evidenceEventId,
			source: "syscall",
			toolCallId: ctx.toolCallId,
		},
		importance: 0.8,
	});
}

export function appendAkashaPrediction(ctx: AkashaTimeSyscallContext, input: CreatePredictionInput): AkashaEvent {
	const predictionId = `prediction:syscall:${ctx.toolCallId ?? stableId(input.claim)}`;
	return ctx.store.append({
		...baseDraft(ctx, "prediction.made", input.sourceEventIds),
		subjectId: "akasha.time_syscall",
		objectId: input.claim,
		sourceKey: `${ctx.sourceKeyPrefix ?? "akasha-syscall"}:prediction:${ctx.toolCallId ?? stableId(input.claim)}`,
		payload: {
			predictionId,
			claim: input.claim,
			checkAfter: input.checkAfter,
			confidence: clampConfidence(input.confidence ?? 0.75),
			resolutionCriteria: input.resolutionCriteria,
			source: "syscall",
			sourceEventIds: input.sourceEventIds ?? [],
			toolCallId: ctx.toolCallId,
		},
		importance: 0.85,
	});
}

export function appendAkashaPredictionCheck(ctx: AkashaTimeSyscallContext, input: CheckPredictionInput): AkashaEvent {
	const kind = input.correct === false || input.correction ? "prediction.corrected" : "prediction.checked";
	return ctx.store.append({
		...baseDraft(ctx, kind, [input.predictionId, input.evidenceEventId]),
		subjectId: "akasha.time_syscall",
		objectId: input.predictionId,
		sourceKey: `${ctx.sourceKeyPrefix ?? "akasha-syscall"}:prediction-checked:${input.predictionId}:${
			ctx.toolCallId ?? "manual"
		}`,
		payload: {
			predictionId: input.predictionId,
			actual: input.actual,
			correct: input.correct,
			correction: input.correction,
			evidenceEventId: input.evidenceEventId,
			source: "syscall",
			toolCallId: ctx.toolCallId,
		},
		importance: kind === "prediction.corrected" ? 0.9 : 0.8,
	});
}

export function isAkashaTimeSyscallToolName(name: string | undefined): name is AkashaTimeSyscallToolName {
	return !!name && (AKASHA_TIME_SYSCALL_TOOL_NAMES as readonly string[]).includes(name);
}

export function eventToolResult(event: AkashaEvent): AgentToolResult<{ eventId: string; kind: string }> {
	return {
		content: [{ type: "text", text: `${event.kind}: ${event.eventId}` }],
		details: { eventId: event.eventId, kind: event.kind },
	};
}

function baseDraft(
	ctx: AkashaTimeSyscallContext,
	kind: AkashaEventDraft["kind"],
	sourceEventIds: Array<string | undefined> = [],
): AkashaEventDraft {
	const parents = [...new Set([...(ctx.parentEventIds ?? []), ...sourceEventIds].filter((id): id is string => !!id))];
	return {
		kind,
		sessionId: ctx.sessionId,
		streamId: ctx.streamId,
		eventTime: ctx.now?.() ?? new Date().toISOString(),
		actor: "agent",
		parentEventIds: parents,
		correlationId: ctx.correlationId,
		toolCallId: ctx.toolCallId,
		ttlPolicy: "long_term",
	};
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
