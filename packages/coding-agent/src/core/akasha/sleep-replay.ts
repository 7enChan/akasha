import { createHash } from "node:crypto";
import { projectAkashaGovernedEvents } from "./governance-projection.js";
import { buildAkashaMemoryTraces } from "./memory-trace.js";
import { orderAkashaEvents } from "./ordering.js";
import { buildAkashaProceduralMemories, createSkillProcedureEventDraft } from "./procedural-memory.js";
import type { AkashaEvent, AkashaEventDraft, AkashaStore } from "./types.js";

export interface AkashaSleepReplayOptions {
	sessionId?: string;
	streamId?: string;
	now?: Date;
	limit?: number;
	maxDerivedEvents?: number;
}

export interface AkashaSleepReplayResult {
	started: AkashaEvent;
	completed: AkashaEvent;
	derived: AkashaEvent[];
	failureLessons: number;
	workflowOptimizations: number;
	procedures: number;
	decays: number;
}

export function runAkashaSleepReplayPass(
	store: AkashaStore,
	options: AkashaSleepReplayOptions = {},
): AkashaSleepReplayResult {
	const now = options.now ?? new Date();
	const timeline = orderAkashaEvents(store.buildTimeline({ limit: options.limit ?? 1000 }));
	const last = timeline.at(-1);
	const sessionId = options.sessionId ?? last?.sessionId ?? "akasha-sleep";
	const streamId = options.streamId ?? last?.streamId ?? `session:${sessionId}`;
	const started = store.append({
		kind: "sleep.replay.started",
		sessionId,
		streamId,
		eventTime: now.toISOString(),
		actor: "system",
		subjectId: "akasha.sleep_replay",
		sourceKey: `sleep-replay:${sessionId}:${now.toISOString()}:started`,
		parentEventIds: last ? [last.eventId] : [],
		payload: {
			limit: options.limit ?? 1000,
			eventCount: timeline.length,
		},
		importance: 0.45,
		ttlPolicy: "long_term",
	});

	const governed = projectAkashaGovernedEvents(timeline).events;
	const maxDerived = options.maxDerivedEvents ?? 12;
	const drafts: AkashaEventDraft[] = [
		...deriveRepeatedFailureLessons(governed, sessionId, streamId, now, started.eventId),
		...deriveCallbackWorkflowOptimizations(governed, sessionId, streamId, now, started.eventId),
		...deriveProcedures(governed, sessionId, streamId, now, started.eventId),
		...deriveMemoryDecay(governed, sessionId, streamId, now, started.eventId),
	].slice(0, maxDerived);
	const derived = drafts.map((draft) => store.append(draft));
	const completed = store.append({
		kind: "sleep.replay.completed",
		sessionId,
		streamId,
		eventTime: now.toISOString(),
		actor: "system",
		subjectId: "akasha.sleep_replay",
		sourceKey: `sleep-replay:${sessionId}:${now.toISOString()}:completed`,
		parentEventIds: [started.eventId, ...derived.map((event) => event.eventId).slice(0, 12)],
		payload: {
			derivedEventIds: derived.map((event) => event.eventId),
			failureLessons: derived.filter((event) => event.kind === "failure.lesson_learned").length,
			workflowOptimizations: derived.filter((event) => event.kind === "workflow.optimized").length,
			procedures: derived.filter((event) => event.kind === "skill.procedure.created").length,
			decays: derived.filter((event) => event.kind === "memory.decayed").length,
		},
		importance: 0.55,
		ttlPolicy: "long_term",
	});
	return {
		started,
		completed,
		derived,
		failureLessons: derived.filter((event) => event.kind === "failure.lesson_learned").length,
		workflowOptimizations: derived.filter((event) => event.kind === "workflow.optimized").length,
		procedures: derived.filter((event) => event.kind === "skill.procedure.created").length,
		decays: derived.filter((event) => event.kind === "memory.decayed").length,
	};
}

export function buildAkashaSleepReplayStatus(events: AkashaEvent[]): {
	lastStarted?: AkashaEvent;
	lastCompleted?: AkashaEvent;
	replayCount: number;
	derivedMemoryCount: number;
} {
	const ordered = orderAkashaEvents(events);
	return {
		lastStarted: [...ordered].reverse().find((event) => event.kind === "sleep.replay.started"),
		lastCompleted: [...ordered].reverse().find((event) => event.kind === "sleep.replay.completed"),
		replayCount: ordered.filter((event) => event.kind === "sleep.replay.completed").length,
		derivedMemoryCount: ordered.filter((event) =>
			["failure.lesson_learned", "workflow.optimized", "skill.procedure.created", "memory.decayed"].includes(
				event.kind,
			),
		).length,
	};
}

function deriveRepeatedFailureLessons(
	events: AkashaEvent[],
	sessionId: string,
	streamId: string,
	now: Date,
	startedEventId: string,
): AkashaEventDraft[] {
	const groups = new Map<string, AkashaEvent[]>();
	for (const event of events.filter(isFailureEvent)) {
		const key = failureKey(event);
		const group = groups.get(key) ?? [];
		group.push(event);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.filter(([, group]) => group.length >= 2)
		.map(([key, group]) => ({
			kind: "failure.lesson_learned" as const,
			sessionId,
			streamId,
			eventTime: now.toISOString(),
			actor: "system" as const,
			subjectId: "akasha.sleep_replay",
			objectId: key,
			sourceKey: `sleep-replay:failure:${hashText(key)}`,
			parentEventIds: [startedEventId, ...group.map((event) => event.eventId).slice(-8)],
			payload: {
				failureKey: key,
				lesson: `Repeated failure around ${key}; inspect causal parents and validation scope before retrying.`,
				summary: `Repeated failure around ${key}`,
				sourceEventIds: group.map((event) => event.eventId),
				confidence: Math.min(0.9, 0.55 + group.length * 0.08),
			},
			importance: 0.85,
			ttlPolicy: "long_term" as const,
		}));
}

function deriveCallbackWorkflowOptimizations(
	events: AkashaEvent[],
	sessionId: string,
	streamId: string,
	now: Date,
	startedEventId: string,
): AkashaEventDraft[] {
	return events
		.filter((event) => event.kind === "time.callback.completed")
		.slice(-6)
		.map((event) => {
			const callbackId = typeof event.payload.callbackId === "string" ? event.payload.callbackId : event.eventId;
			return {
				kind: "workflow.optimized" as const,
				sessionId,
				streamId,
				eventTime: now.toISOString(),
				actor: "system" as const,
				subjectId: "akasha.sleep_replay",
				objectId: callbackId,
				sourceKey: `sleep-replay:callback-workflow:${callbackId}`,
				parentEventIds: [startedEventId, event.eventId],
				payload: {
					title: "Close due callback through explicit syscall",
					trigger: "When a due callback enters resume context",
					summary:
						"Review the causal chain, act if still relevant, then resolve commitment or check prediction with callbackId/inboxItemId.",
					steps: [
						"Inspect the due callback and its target event",
						"Act only if the callback is still relevant",
						"Close the loop with akasha_resolve_commitment or akasha_check_prediction",
					],
					sourceEventIds: [event.eventId],
					confidence: 0.76,
				},
				importance: 0.72,
				ttlPolicy: "long_term" as const,
			};
		});
}

function deriveProcedures(
	events: AkashaEvent[],
	sessionId: string,
	streamId: string,
	now: Date,
	startedEventId: string,
): AkashaEventDraft[] {
	const procedures = buildAkashaProceduralMemories(events, { maxProcedures: 6 }).filter(
		(procedure) => procedure.maturity === "validated",
	);
	return procedures.map((procedure) =>
		createSkillProcedureEventDraft(procedure, {
			sessionId,
			streamId,
			eventTime: now.toISOString(),
			parentEventIds: [startedEventId, ...procedure.sourceEventIds.slice(0, 8)],
			sourceKeyPrefix: "sleep-replay:procedure",
		}),
	);
}

function deriveMemoryDecay(
	events: AkashaEvent[],
	sessionId: string,
	streamId: string,
	now: Date,
	startedEventId: string,
): AkashaEventDraft[] {
	const traces = buildAkashaMemoryTraces(events);
	return traces
		.filter(
			(trace) =>
				trace.recallCount > 0 &&
				trace.weight < 0.3 &&
				trace.confidence < 0.8 &&
				["semantic", "artifact", "failure", "callback", "skill", "policy"].includes(trace.kind),
		)
		.slice(0, 3)
		.map((trace) => ({
			kind: "memory.decayed" as const,
			sessionId,
			streamId,
			eventTime: now.toISOString(),
			actor: "system" as const,
			subjectId: "akasha.sleep_replay",
			objectId: trace.eventId,
			sourceKey: `sleep-replay:memory-decay:${trace.traceId}`,
			parentEventIds: [startedEventId, trace.eventId],
			payload: {
				traceId: trace.traceId,
				targetEventId: trace.eventId,
				reason: "low_weight_trace",
				sourceEventIds: trace.sourceEventIds,
			},
			importance: 0.3,
			ttlPolicy: "long_term" as const,
		}));
}

function isFailureEvent(event: AkashaEvent): boolean {
	return (
		event.kind === "tool.blocked" ||
		event.kind === "loop.blocked" ||
		event.kind === "prediction.corrected" ||
		event.kind === "time.callback.failed" ||
		event.kind === "gateway.delivery.failed" ||
		(event.kind === "tool.completed" && event.payload.isError === true) ||
		(event.kind === "command.executed" && typeof event.payload.exitCode === "number" && event.payload.exitCode !== 0)
	);
}

function failureKey(event: AkashaEvent): string {
	return (
		stringPayload(event, "toolName") ??
		stringPayload(event, "command") ??
		stringPayload(event, "rule") ??
		stringPayload(event, "ruleId") ??
		event.objectId ??
		event.kind
	);
}

function stringPayload(event: AkashaEvent, key: string): string | undefined {
	const value = event.payload[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
