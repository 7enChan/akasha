import { createHash } from "node:crypto";
import { projectAkashaGovernedEvents } from "./governance-projection.js";
import { orderAkashaEvents } from "./ordering.js";
import {
	type AkashaProcedurePolicy,
	commandFailed,
	commandSucceeded,
	DEFAULT_AKASHA_PROCEDURE_POLICY,
	isValidationProcedureCommand,
} from "./procedure-policy.js";
import type { AkashaEvent, AkashaEventDraft } from "./types.js";

export interface AkashaProcedure {
	procedureId: string;
	scopeKey: string;
	maturity: "candidate" | "validated";
	title: string;
	trigger: string;
	steps: string[];
	contraindications: string[];
	validation: string[];
	sourceEventIds: string[];
	confidence: number;
	successCount: number;
	failureCount: number;
}

export interface AkashaProceduralMemoryOptions {
	policy?: Partial<AkashaProcedurePolicy>;
	maxProcedures?: number;
}

export function buildAkashaProceduralMemories(
	events: AkashaEvent[],
	options: AkashaProceduralMemoryOptions = {},
): AkashaProcedure[] {
	const policy = { ...DEFAULT_AKASHA_PROCEDURE_POLICY, ...(options.policy ?? {}) };
	const byId = new Map<string, AkashaProcedure>();
	for (const event of orderAkashaEvents(projectAkashaGovernedEvents(events).events)) {
		const candidates = proceduresFromEvent(event);
		for (const candidate of candidates) {
			const previous = byId.get(candidate.procedureId);
			byId.set(candidate.procedureId, previous ? mergeProcedure(previous, candidate) : candidate);
		}
	}
	return [...byId.values()]
		.filter((procedure) => procedure.confidence >= policy.minConfidence)
		.sort((a, b) => b.confidence - a.confidence || b.successCount - a.successCount)
		.slice(0, options.maxProcedures ?? policy.maxProcedures);
}

export function createSkillProcedureEventDraft(
	procedure: AkashaProcedure,
	options: {
		sessionId: string;
		streamId: string;
		eventTime?: string;
		parentEventIds?: string[];
		sourceKeyPrefix?: string;
	},
): AkashaEventDraft {
	return {
		kind: "skill.procedure.created",
		sessionId: options.sessionId,
		streamId: options.streamId,
		eventTime: options.eventTime ?? new Date().toISOString(),
		actor: "system",
		subjectId: "akasha.procedural_memory",
		objectId: procedure.procedureId,
		sourceKey: `${options.sourceKeyPrefix ?? "skill-procedure"}:${procedure.procedureId}`,
		parentEventIds: options.parentEventIds ?? procedure.sourceEventIds.slice(0, 8),
		payload: {
			procedureId: procedure.procedureId,
			title: procedure.title,
			trigger: procedure.trigger,
			steps: procedure.steps,
			contraindications: procedure.contraindications,
			validation: procedure.validation,
			sourceEventIds: procedure.sourceEventIds,
			confidence: procedure.confidence,
			successCount: procedure.successCount,
			failureCount: procedure.failureCount,
			scopeKey: procedure.scopeKey,
			maturity: procedure.maturity,
		},
		importance: 0.75,
		ttlPolicy: "long_term",
	};
}

export function createSkillProcedureAppliedDraft(
	procedure: AkashaProcedure,
	options: {
		sessionId: string;
		streamId: string;
		recallEventId: string;
		memoryAppliedEventId: string;
		toolCallId?: string;
		toolName?: string;
		eventTime?: string;
		parentEventIds?: string[];
		sourceKeyPrefix?: string;
	},
): AkashaEventDraft {
	return skillProcedureFeedbackDraft("skill.procedure.applied", procedure, {
		...options,
		payload: {
			recallEventId: options.recallEventId,
			memoryAppliedEventId: options.memoryAppliedEventId,
			toolCallId: options.toolCallId,
			toolName: options.toolName,
		},
		importance: 0.55,
	});
}

export function createSkillProcedureOutcomeDraft(
	kind: "skill.procedure.reinforced" | "skill.procedure.failed",
	procedure: AkashaProcedure,
	options: {
		sessionId: string;
		streamId: string;
		appliedEventId: string;
		outcomeEvent: AkashaEvent;
		reason: string;
		eventTime?: string;
		parentEventIds?: string[];
		sourceKeyPrefix?: string;
	},
): AkashaEventDraft {
	return skillProcedureFeedbackDraft(kind, procedure, {
		...options,
		toolCallId: options.outcomeEvent.toolCallId,
		payload: {
			appliedEventId: options.appliedEventId,
			outcomeEventId: options.outcomeEvent.eventId,
			reason: options.reason,
			toolCallId: options.outcomeEvent.toolCallId,
		},
		importance: kind === "skill.procedure.reinforced" ? 0.65 : 0.82,
	});
}

export function formatAkashaProcedures(procedures: AkashaProcedure[], maxItems = 2): string[] {
	return procedures.slice(0, maxItems).map((procedure) => {
		const steps = procedure.steps.slice(0, 4).map((step, index) => `${index + 1}. ${step}`);
		const validation = procedure.validation.length > 0 ? ` validation: ${procedure.validation.join("; ")}` : "";
		return `${procedure.title} (${Math.round(procedure.confidence * 100)}%): ${steps.join(" ")}${validation}`;
	});
}

function proceduresFromEvent(event: AkashaEvent): AkashaProcedure[] {
	if (commandSucceeded(event)) {
		const command = stringPayload(event, "command");
		if (command && isValidationProcedureCommand(command)) {
			return [validationProcedure(event, command, 1, 0)];
		}
	}
	if (commandFailed(event)) {
		const command = stringPayload(event, "command");
		if (command && isValidationProcedureCommand(command)) {
			return [validationProcedure(event, command, 0, 1)];
		}
	}
	if (event.kind === "workflow.optimized") {
		const title = stringPayload(event, "title") ?? stringPayload(event, "summary") ?? "Workflow pattern";
		const steps = stringArrayPayload(event, "steps");
		return [
			{
				procedureId: procedureId("workflow", title),
				scopeKey: `workflow:${title}`,
				maturity: "validated",
				title: truncate(title, 90),
				trigger: stringPayload(event, "trigger") ?? "When the same workflow context appears",
				steps:
					steps.length > 0
						? steps.slice(0, 6)
						: [stringPayload(event, "summary") ?? "Reuse the optimized workflow"],
				contraindications: [],
				validation: stringArrayPayload(event, "validation"),
				sourceEventIds: sourceEventIds(event),
				confidence: numberPayload(event, "confidence") ?? 0.72,
				successCount: 1,
				failureCount: 0,
			},
		];
	}
	if (event.kind === "failure.lesson_learned") {
		const lesson =
			stringPayload(event, "lesson") ?? stringPayload(event, "summary") ?? "Avoid repeating this failure";
		return [
			{
				procedureId: procedureId("lesson", lesson),
				scopeKey: `lesson:${lesson}`,
				maturity: "candidate",
				title: truncate(`Avoid repeat failure: ${lesson}`, 90),
				trigger: stringPayload(event, "trigger") ?? "When a similar failure pressure appears",
				steps: [lesson, "Validate the corrected path before closing the loop"],
				contraindications: [
					stringPayload(event, "failureKey") ?? "Do not repeat the failed action without changed evidence",
				],
				validation: stringArrayPayload(event, "validation"),
				sourceEventIds: sourceEventIds(event),
				confidence: numberPayload(event, "confidence") ?? 0.68,
				successCount: 0,
				failureCount: 1,
			},
		];
	}
	if (event.kind === "skill.procedure.created" || event.kind === "skill.procedure.updated") {
		const procedureIdValue = stringPayload(event, "procedureId") ?? stringPayload(event, "title") ?? event.eventId;
		return [
			{
				procedureId: procedureIdValue,
				scopeKey: stringPayload(event, "scopeKey") ?? `persisted:${procedureIdValue}`,
				maturity: event.payload.maturity === "validated" ? "validated" : "candidate",
				title: truncate(stringPayload(event, "title") ?? procedureIdValue, 90),
				trigger: stringPayload(event, "trigger") ?? "When the procedure trigger matches",
				steps: stringArrayPayload(event, "steps"),
				contraindications: stringArrayPayload(event, "contraindications"),
				validation: stringArrayPayload(event, "validation"),
				sourceEventIds: sourceEventIds(event),
				confidence: numberPayload(event, "confidence") ?? 0.75,
				successCount: numberPayload(event, "successCount") ?? 0,
				failureCount: numberPayload(event, "failureCount") ?? 0,
			},
		];
	}
	if (event.kind === "skill.procedure.reinforced" || event.kind === "skill.procedure.failed") {
		const procedureIdValue = stringPayload(event, "procedureId") ?? event.objectId ?? event.eventId;
		return [
			{
				procedureId: procedureIdValue,
				scopeKey: stringPayload(event, "scopeKey") ?? `feedback:${procedureIdValue}`,
				maturity: event.kind === "skill.procedure.reinforced" ? "validated" : "candidate",
				title: truncate(stringPayload(event, "title") ?? procedureIdValue, 90),
				trigger: stringPayload(event, "trigger") ?? "When the procedure trigger matches",
				steps: stringArrayPayload(event, "steps"),
				contraindications: stringArrayPayload(event, "contraindications"),
				validation: stringArrayPayload(event, "validation"),
				sourceEventIds: sourceEventIds(event),
				confidence: numberPayload(event, "confidence") ?? 0.65,
				successCount: event.kind === "skill.procedure.reinforced" ? 1 : 0,
				failureCount: event.kind === "skill.procedure.failed" ? 1 : 0,
			},
		];
	}
	return [];
}

function validationProcedure(event: AkashaEvent, command: string, success: number, failure: number): AkashaProcedure {
	const normalized = command.replace(/\s+/g, " ").trim();
	const cwd = stringPayload(event, "cwd") ?? "unknown-cwd";
	const scopeKey = `${cwd}:${normalized}`;
	return {
		procedureId: procedureId("validation", scopeKey),
		scopeKey,
		maturity: "candidate",
		title: truncate(`Validate with ${normalized}`, 90),
		trigger: cwd === "unknown-cwd" ? "When related artifacts change" : cwd,
		steps: [
			"Identify the package or project root for the changed artifacts",
			`Run ${normalized}`,
			"Only close the loop after the validation result is observed",
		],
		contraindications: failure > 0 ? [`Previous failure for ${normalized}; inspect cwd and target paths first`] : [],
		validation: [normalized],
		sourceEventIds: sourceEventIds(event),
		confidence: success > 0 ? 0.58 : 0.56,
		successCount: success,
		failureCount: failure,
	};
}

function skillProcedureFeedbackDraft(
	kind: "skill.procedure.applied" | "skill.procedure.reinforced" | "skill.procedure.failed",
	procedure: AkashaProcedure,
	options: {
		sessionId: string;
		streamId: string;
		eventTime?: string;
		parentEventIds?: string[];
		sourceKeyPrefix?: string;
		toolCallId?: string;
		payload: Record<string, unknown>;
		importance: number;
	},
): AkashaEventDraft {
	return {
		kind,
		sessionId: options.sessionId,
		streamId: options.streamId,
		eventTime: options.eventTime ?? new Date().toISOString(),
		actor: "system",
		subjectId: "akasha.procedural_memory",
		objectId: procedure.procedureId,
		toolCallId: options.toolCallId,
		sourceKey: `${options.sourceKeyPrefix ?? kind}:${procedure.procedureId}:${
			stringPayloadFromRecord(options.payload, "toolCallId") ??
			stringPayloadFromRecord(options.payload, "outcomeEventId") ??
			stringPayloadFromRecord(options.payload, "memoryAppliedEventId") ??
			"event"
		}`,
		parentEventIds: options.parentEventIds ?? procedure.sourceEventIds.slice(0, 8),
		payload: {
			procedureId: procedure.procedureId,
			scopeKey: procedure.scopeKey,
			maturity: procedure.maturity,
			title: procedure.title,
			trigger: procedure.trigger,
			steps: procedure.steps,
			contraindications: procedure.contraindications,
			validation: procedure.validation,
			sourceEventIds: procedure.sourceEventIds,
			confidence: procedure.confidence,
			successCount: procedure.successCount,
			failureCount: procedure.failureCount,
			...options.payload,
		},
		importance: options.importance,
		ttlPolicy: "long_term",
	};
}

function stringPayloadFromRecord(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mergeProcedure(a: AkashaProcedure, b: AkashaProcedure): AkashaProcedure {
	const successCount = a.successCount + b.successCount;
	const failureCount = a.failureCount + b.failureCount;
	const confidence = clamp01(
		(a.confidence + b.confidence) / 2 + Math.min(0.15, successCount * 0.03) - failureCount * 0.02,
	);
	const maturity =
		successCount >= 2 || a.maturity === "validated" || b.maturity === "validated" ? "validated" : "candidate";
	return {
		...a,
		steps: uniqueStrings([...a.steps, ...b.steps]).slice(0, 8),
		contraindications: uniqueStrings([...a.contraindications, ...b.contraindications]).slice(0, 6),
		validation: uniqueStrings([...a.validation, ...b.validation]).slice(0, 6),
		sourceEventIds: uniqueStrings([...a.sourceEventIds, ...b.sourceEventIds]),
		confidence,
		successCount,
		failureCount,
		maturity,
	};
}

function sourceEventIds(event: AkashaEvent): string[] {
	return uniqueStrings([
		event.eventId,
		...event.parentEventIds,
		...stringArrayPayload(event, "sourceEventIds"),
		...stringArrayPayload(event, "supportingEventIds"),
		...stringArrayPayload(event, "evidenceEventIds"),
	]);
}

function procedureId(scope: string, value: string): string {
	return `procedure_${scope}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
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

function numberPayload(event: AkashaEvent, key: string): number | undefined {
	const value = event.payload[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.trim()))];
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}
