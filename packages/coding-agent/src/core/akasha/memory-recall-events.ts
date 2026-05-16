import { createHash } from "node:crypto";
import type { AkashaReconstructedMemoryField } from "./holographic-memory.js";
import type { AkashaMemoryCue } from "./memory-cue.js";
import type { AkashaMemoryRecallScope } from "./memory-recall-scope.js";
import type { AkashaEvent, AkashaEventDraft } from "./types.js";

export function createMemoryRecalledDraft(input: {
	sessionId: string;
	streamId: string;
	cue: AkashaMemoryCue;
	field: AkashaReconstructedMemoryField;
	parentEventIds?: string[];
	sourceKey?: string;
	correlationId?: string;
	eventTime?: string;
	scope?: AkashaMemoryRecallScope;
}): AkashaEventDraft {
	return {
		kind: "memory.recalled",
		sessionId: input.sessionId,
		streamId: input.streamId,
		eventTime: input.eventTime ?? new Date().toISOString(),
		actor: "system",
		subjectId: "akasha.holographic_memory",
		objectId: input.field.fieldId,
		sourceKey: input.sourceKey ?? `memory-recalled:${input.sessionId}:${input.field.fieldId}`,
		parentEventIds: input.parentEventIds ?? input.field.sourceEventIds.slice(0, 12),
		correlationId: input.correlationId,
		payload: {
			cueId: input.cue.cueId,
			cueHash: hashJson(input.cue),
			fieldId: input.field.fieldId,
			recalledEventIds: input.field.recalledEventIds,
			recalledTraceIds: input.field.recalledTraceIds,
			recalledEdgeIds: input.field.recalledEdgeIds,
			recalledCrystalIds: input.field.recalledCrystalIds,
			activationReasons: input.field.activationReasons,
			semanticSeedEventIds: input.field.semanticSeedEventIds,
			semanticSeedReasons: input.field.semanticSeedReasons,
			procedureIds: input.field.procedures.map((procedure) => procedure.procedureId),
			contextualValidity: input.field.contextualValidityAnnotations.map((annotation) => ({
				claimId: annotation.claimId,
				claimKey: annotation.claimKey,
				status: annotation.status,
				dependency: annotation.dependency,
				useAs: annotation.useAs,
				traceIds: annotation.traceIds,
				eventIds: annotation.eventIds,
				supersededByClaimId: annotation.supersededByClaimId,
			})),
			sections: ["episodes", "lessons", "procedures", "warnings", "contextual_validity"].filter((section) =>
				fieldHasSection(input.field, section),
			),
			tokenEstimate: input.field.tokenEstimate,
			topReasons: input.field.topReasons,
			sourceEventIds: input.field.sourceEventIds,
			scope: input.scope,
		},
		importance: input.field.warnings.some((warning) => warning.severity === "critical") ? 0.85 : 0.65,
		ttlPolicy: "long_term",
	};
}

export function createMemoryAppliedDraft(input: {
	sessionId: string;
	streamId: string;
	recallEventId: string;
	actionType: string;
	toolCallId?: string;
	toolName?: string;
	procedureIds?: string[];
	parentEventIds?: string[];
	correlationId?: string;
	sourceKey?: string;
	eventTime?: string;
}): AkashaEventDraft {
	return {
		kind: "memory.applied",
		sessionId: input.sessionId,
		streamId: input.streamId,
		eventTime: input.eventTime ?? new Date().toISOString(),
		actor: "system",
		subjectId: "akasha.holographic_memory",
		objectId: input.recallEventId,
		toolCallId: input.toolCallId,
		sourceKey: input.sourceKey,
		parentEventIds: input.parentEventIds ?? [input.recallEventId],
		correlationId: input.correlationId,
		payload: {
			recallEventId: input.recallEventId,
			actionType: input.actionType,
			toolName: input.toolName,
			toolCallId: input.toolCallId,
			procedureIds: input.procedureIds ?? [],
		},
		importance: 0.55,
		ttlPolicy: "long_term",
	};
}

export function createMemoryOutcomeDraft(input: {
	kind: "memory.reinforced" | "memory.weakened";
	sessionId: string;
	streamId: string;
	recallEventId: string;
	appliedEventId: string;
	outcomeEvent: AkashaEvent;
	reason: string;
	sourceKey?: string;
	eventTime?: string;
}): AkashaEventDraft {
	return {
		kind: input.kind,
		sessionId: input.sessionId,
		streamId: input.streamId,
		eventTime: input.eventTime ?? new Date().toISOString(),
		actor: "system",
		subjectId: "akasha.holographic_memory",
		objectId: input.recallEventId,
		toolCallId: input.outcomeEvent.toolCallId,
		sourceKey: input.sourceKey,
		parentEventIds: [input.appliedEventId, input.outcomeEvent.eventId],
		correlationId: input.outcomeEvent.correlationId,
		payload: {
			recallEventId: input.recallEventId,
			appliedEventId: input.appliedEventId,
			outcomeEventId: input.outcomeEvent.eventId,
			reason: input.reason,
		},
		importance: input.kind === "memory.reinforced" ? 0.6 : 0.75,
		ttlPolicy: "long_term",
	};
}

export function createMemoryReconsolidatedDraft(input: {
	sessionId: string;
	streamId: string;
	oldMemoryEventId: string;
	newMemoryEventId: string;
	reason: string;
	sourceEventIds?: string[];
	parentEventIds?: string[];
	eventTime?: string;
	sourceKey?: string;
}): AkashaEventDraft {
	return {
		kind: "memory.reconsolidated",
		sessionId: input.sessionId,
		streamId: input.streamId,
		eventTime: input.eventTime ?? new Date().toISOString(),
		actor: "system",
		subjectId: "akasha.holographic_memory",
		objectId: input.oldMemoryEventId,
		sourceKey: input.sourceKey,
		parentEventIds: input.parentEventIds ?? [input.oldMemoryEventId, input.newMemoryEventId],
		payload: {
			oldMemoryEventId: input.oldMemoryEventId,
			newMemoryEventId: input.newMemoryEventId,
			reason: input.reason,
			sourceEventIds: input.sourceEventIds ?? [input.oldMemoryEventId, input.newMemoryEventId],
		},
		importance: 0.8,
		ttlPolicy: "long_term",
	};
}

function fieldHasSection(field: AkashaReconstructedMemoryField, section: string): boolean {
	if (section === "episodes") return field.episodes.length > 0;
	if (section === "lessons") return field.lessons.length > 0;
	if (section === "procedures") return field.procedures.length > 0;
	if (section === "warnings") return field.warnings.length > 0;
	if (section === "contextual_validity") return field.contextualValidityAnnotations.length > 0;
	return false;
}

function hashJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
