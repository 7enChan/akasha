import { createHash } from "node:crypto";
import { projectAkashaGovernedEvents } from "./governance-projection.js";
import { applyAkashaMemoryFeedbackToTraces, buildAkashaMemoryFeedback } from "./memory-feedback.js";
import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent } from "./types.js";

export type AkashaMemoryTraceKind =
	| "time"
	| "semantic"
	| "artifact"
	| "task"
	| "goal"
	| "actor"
	| "tool"
	| "policy"
	| "failure"
	| "success"
	| "callback"
	| "closure"
	| "valence"
	| "skill";

export interface AkashaMemoryTrace {
	traceId: string;
	eventId: string;
	sourceEventIds: string[];
	kind: AkashaMemoryTraceKind;
	key: string;
	text: string;
	weight: number;
	confidence: number;
	valence?: number;
	surprise?: number;
	cost?: number;
	reward?: number;
	createdAt: string;
	lastRecalledAt?: string;
	recallCount: number;
}

export function buildAkashaMemoryTraces(events: AkashaEvent[]): AkashaMemoryTrace[] {
	const governed = orderAkashaEvents(projectAkashaGovernedEvents(events).events);
	const traces = governed.flatMap(eventToTraces);
	return applyAkashaMemoryFeedbackToTraces(traces, buildAkashaMemoryFeedback(governed));
}

export function createAkashaMemoryTrace(
	event: AkashaEvent,
	kind: AkashaMemoryTraceKind,
	key: string,
	text: string,
	options: {
		weight?: number;
		confidence?: number;
		valence?: number;
		surprise?: number;
		cost?: number;
		reward?: number;
		sourceEventIds?: string[];
	} = {},
): AkashaMemoryTrace {
	const normalizedKey = normalizeKey(key || event.kind);
	const sourceEventIds = uniqueStrings([
		event.eventId,
		...sourceIdsFromEvent(event),
		...(options.sourceEventIds ?? []),
	]);
	return {
		traceId: deterministicTraceId(event.eventId, kind, normalizedKey),
		eventId: event.eventId,
		sourceEventIds,
		kind,
		key: normalizedKey,
		text: truncate(text || summarizeEvent(event), 280),
		weight: clamp01(options.weight ?? defaultWeight(kind, event)),
		confidence: clamp01(options.confidence ?? 0.75),
		valence: options.valence,
		surprise: options.surprise,
		cost: options.cost,
		reward: options.reward,
		createdAt: event.eventTime,
		recallCount: 0,
	};
}

function eventToTraces(event: AkashaEvent): AkashaMemoryTrace[] {
	const traces: AkashaMemoryTrace[] = [];
	const summary = summarizeEvent(event);
	const artifact = artifactKey(event);
	const tool = toolKey(event);

	traces.push(
		createAkashaMemoryTrace(event, "time", timeKey(event), `${event.kind} at ${event.eventTime}`, { weight: 0.25 }),
	);
	traces.push(
		createAkashaMemoryTrace(event, "actor", event.actor, `${event.actor} produced ${event.kind}`, { weight: 0.2 }),
	);

	if (summary) {
		traces.push(createAkashaMemoryTrace(event, "semantic", event.kind, summary, { weight: semanticWeight(event) }));
	}

	if (artifact) {
		traces.push(
			createAkashaMemoryTrace(event, "artifact", artifact, `${event.kind} touched ${artifact}: ${summary}`, {
				weight: 0.7,
				confidence: 0.85,
			}),
		);
	}

	if (tool) {
		traces.push(
			createAkashaMemoryTrace(event, "tool", tool, `${tool} ${event.kind}: ${summary}`, {
				weight: 0.55,
				confidence: 0.85,
			}),
		);
	}

	if (event.kind === "message.user.submitted") {
		traces.push(createAkashaMemoryTrace(event, "goal", "user-intent", summary, { weight: 0.7, confidence: 0.65 }));
	}

	if (isTaskEvent(event)) {
		traces.push(createAkashaMemoryTrace(event, "task", taskKey(event), summary, { weight: 0.65, confidence: 0.75 }));
	}

	if (isFailureEvent(event)) {
		traces.push(
			createAkashaMemoryTrace(event, "failure", failureKey(event), summary, {
				weight: 0.9,
				confidence: 0.9,
				valence: -0.8,
				surprise: event.kind === "prediction.corrected" ? 0.9 : 0.55,
				cost: 0.75,
			}),
		);
		traces.push(
			createAkashaMemoryTrace(event, "valence", "negative", summary, {
				weight: 0.8,
				confidence: 0.85,
				valence: -0.8,
				surprise: event.kind === "prediction.corrected" ? 0.9 : 0.55,
				cost: 0.75,
			}),
		);
	}

	if (isSuccessEvent(event)) {
		traces.push(
			createAkashaMemoryTrace(event, "success", successKey(event), summary, {
				weight: 0.7,
				confidence: 0.85,
				valence: 0.65,
				reward: 0.7,
			}),
		);
		traces.push(
			createAkashaMemoryTrace(event, "valence", "positive", summary, {
				weight: 0.55,
				confidence: 0.75,
				valence: 0.65,
				reward: 0.7,
			}),
		);
	}

	if (isCallbackEvent(event)) {
		traces.push(
			createAkashaMemoryTrace(event, "callback", callbackKey(event), summary, {
				weight: event.kind === "time.callback.due" ? 0.9 : 0.7,
				confidence: 0.9,
			}),
		);
	}

	if (isClosureEvent(event)) {
		traces.push(
			createAkashaMemoryTrace(event, "closure", closureKey(event), summary, {
				weight: 0.8,
				confidence: 0.85,
				valence: 0.55,
				reward: 0.75,
			}),
		);
	}

	if (event.kind === "policy.evaluated") {
		traces.push(
			createAkashaMemoryTrace(event, "policy", policyKey(event), summary, {
				weight: event.payload.decision === "allow" ? 0.45 : 0.85,
				confidence: 0.9,
				valence: event.payload.decision === "allow" ? 0.1 : -0.35,
				surprise: event.payload.decision === "allow" ? 0.1 : 0.5,
			}),
		);
	}

	if (isSkillEvent(event)) {
		traces.push(
			createAkashaMemoryTrace(event, "skill", skillKey(event), summary, {
				weight: 0.8,
				confidence: 0.75,
			}),
		);
	}

	return dedupeTraces(traces);
}

function summarizeEvent(event: AkashaEvent): string {
	const payload = event.payload;
	const values = [
		stringValue(payload.text),
		stringValue(payload.summary),
		stringValue(payload.reason),
		stringValue(payload.command),
		stringValue(payload.path),
		stringValue(payload.claim),
		stringValue(payload.statement),
		stringValue(payload.ruleId),
		stringValue(payload.decision),
		stringValue(payload.callbackId),
		stringValue(event.objectId),
		stringValue(event.subjectId),
	].filter((value): value is string => Boolean(value?.trim()));
	return truncate(values.join(" | ") || event.kind, 320);
}

function sourceIdsFromEvent(event: AkashaEvent): string[] {
	return uniqueStrings([
		...event.parentEventIds,
		...stringArrayValue(event.payload.sourceEventIds),
		...stringArrayValue(event.payload.supportingEventIds),
		...stringArrayValue(event.payload.evidenceEventIds),
		...stringArrayValue(event.payload.eventIds),
		...stringArrayValue(event.payload.outputEventIds),
	]);
}

function artifactKey(event: AkashaEvent): string | undefined {
	return firstFileLike(
		stringValue(event.objectId),
		stringValue(event.payload.path),
		stringValue(event.payload.filePath),
		stringValue(event.payload.cwd),
	);
}

function toolKey(event: AkashaEvent): string | undefined {
	return (
		stringValue(event.payload.toolName) ?? (event.kind.startsWith("tool.") ? stringValue(event.subjectId) : undefined)
	);
}

function timeKey(event: AkashaEvent): string {
	const day = event.eventTime.slice(0, 10);
	return `${event.sessionId}:${day}:${event.kind}`;
}

function taskKey(event: AkashaEvent): string {
	return stringValue(event.payload.callbackId) ?? stringValue(event.objectId) ?? event.kind;
}

function failureKey(event: AkashaEvent): string {
	return toolKey(event) ?? artifactKey(event) ?? stringValue(event.payload.ruleId) ?? event.kind;
}

function successKey(event: AkashaEvent): string {
	return toolKey(event) ?? stringValue(event.payload.callbackId) ?? event.kind;
}

function callbackKey(event: AkashaEvent): string {
	return stringValue(event.payload.callbackId) ?? stringValue(event.objectId) ?? event.kind;
}

function closureKey(event: AkashaEvent): string {
	return stringValue(event.payload.callbackId) ?? stringValue(event.payload.inboxItemId) ?? event.kind;
}

function policyKey(event: AkashaEvent): string {
	return stringValue(event.payload.ruleId) ?? stringValue(event.payload.actionType) ?? event.kind;
}

function skillKey(event: AkashaEvent): string {
	return stringValue(event.payload.procedureId) ?? stringValue(event.payload.patternId) ?? event.kind;
}

function isTaskEvent(event: AkashaEvent): boolean {
	return (
		event.kind === "loop.opened" ||
		event.kind === "loop.blocked" ||
		event.kind === "promise.created" ||
		event.kind === "time.callback.due" ||
		event.kind === "callback.inbox.injected"
	);
}

function isFailureEvent(event: AkashaEvent): boolean {
	return (
		(event.kind === "tool.completed" && event.payload.isError === true) ||
		(event.kind === "command.executed" &&
			numberValue(event.payload.exitCode) !== undefined &&
			numberValue(event.payload.exitCode) !== 0) ||
		event.kind === "tool.blocked" ||
		event.kind === "loop.blocked" ||
		event.kind === "prediction.corrected" ||
		event.kind === "time.callback.failed" ||
		event.kind === "gateway.delivery.failed" ||
		event.kind === "failure.lesson_learned"
	);
}

function isSuccessEvent(event: AkashaEvent): boolean {
	return (
		(event.kind === "tool.completed" && event.payload.isError === false) ||
		(event.kind === "command.executed" && numberValue(event.payload.exitCode) === 0) ||
		event.kind === "time.callback.completed" ||
		event.kind === "callback.inbox.consumed" ||
		event.kind === "promise.resolved" ||
		event.kind === "prediction.checked" ||
		event.kind === "gateway.reply.sent"
	);
}

function isCallbackEvent(event: AkashaEvent): boolean {
	return event.kind.startsWith("time.callback.") || event.kind.startsWith("callback.inbox.");
}

function isClosureEvent(event: AkashaEvent): boolean {
	return (
		event.kind === "time.callback.completed" ||
		event.kind === "callback.inbox.consumed" ||
		event.kind === "promise.resolved" ||
		event.kind === "prediction.checked"
	);
}

function isSkillEvent(event: AkashaEvent): boolean {
	return (
		event.kind === "workflow.optimized" ||
		event.kind === "pattern.detected" ||
		event.kind === "failure.lesson_learned" ||
		event.kind === "memory.crystal.created" ||
		event.kind === "memory.crystal.updated"
	);
}

function semanticWeight(event: AkashaEvent): number {
	if (event.kind === "failure.lesson_learned" || event.kind === "workflow.optimized") return 0.85;
	if (event.kind === "message.user.submitted") return 0.7;
	if (event.kind === "message.agent.completed") return 0.55;
	return 0.5;
}

function defaultWeight(kind: AkashaMemoryTraceKind, event: AkashaEvent): number {
	if (kind === "failure" || kind === "callback") return 0.85;
	if (kind === "policy" && event.payload.decision !== "allow") return 0.85;
	if (kind === "success" || kind === "closure") return 0.7;
	if (kind === "artifact" || kind === "task" || kind === "goal") return 0.65;
	if (kind === "semantic") return semanticWeight(event);
	return 0.4;
}

function deterministicTraceId(eventId: string, kind: AkashaMemoryTraceKind, key: string): string {
	return `trace_${createHash("sha256").update(`${eventId}:${kind}:${key}`).digest("hex").slice(0, 24)}`;
}

function dedupeTraces(traces: AkashaMemoryTrace[]): AkashaMemoryTrace[] {
	const byId = new Map<string, AkashaMemoryTrace>();
	for (const trace of traces) byId.set(trace.traceId, trace);
	return [...byId.values()];
}

function firstFileLike(...values: Array<string | undefined>): string | undefined {
	return values.find((value) => !!value && (value.includes("/") || value.includes(".")));
}

function normalizeKey(value: string): string {
	return truncate(value.trim().replace(/\s+/g, " "), 180);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.trim()))];
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}
