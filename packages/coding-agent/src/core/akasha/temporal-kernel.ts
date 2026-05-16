import { createHash } from "node:crypto";
import type { ToolCallEvent } from "../extensions/types.js";
import type {
	ResolvedAkashaActionGateSettings,
	ResolvedAkashaHolographicMemorySettings,
	ResolvedAkashaReflectionSettings,
} from "../settings-manager.js";
import { type AkashaActionGateContext, buildAkashaActionGateContext } from "./action-gate.js";
import {
	type AkashaCallbackRunnerOptions,
	type AkashaCallbackRunnerResult,
	runAkashaCallbackRunner,
} from "./callback-runner.js";
import {
	type AkashaCallbackDraftOptions,
	type AkashaDaemonQueuePassResult,
	createCallbackScheduledDraft,
	markAkashaCallbackCancelled,
	markAkashaCallbackCompleted,
	runAkashaDaemonQueuePass,
} from "./daemon-queue.js";
import { projectAkashaGovernedEvents } from "./governance-projection.js";
import { type AkashaReconstructedMemoryField, reconstructAkashaMemoryField } from "./holographic-memory.js";
import { buildAkashaMemoryCue } from "./memory-cue.js";
import { createMemoryRecalledDraft } from "./memory-recall-events.js";
import { createAkashaMemoryRecallScope } from "./memory-recall-scope.js";
import {
	buildCachedAkashaMemoryTraceEdgesFromEvents,
	buildCachedAkashaMemoryTraces,
	buildCachedAkashaMemoryTracesFromEvents,
	memoryTraceEdgeProjectionCacheKeyForScope,
	memoryTraceProjectionCacheKeyForScope,
} from "./memory-trace-cache.js";
import {
	type AkashaPolicyDecision,
	type AkashaPolicyRule,
	type AkashaRuntimePolicyAction,
	createPolicyEvaluatedPayload,
	evaluateAkashaRuntimePolicy,
} from "./policy-kernel.js";
import { buildAkashaProjectTimeline } from "./project-timeline.js";
import {
	type AkashaCachedProjectionResult,
	type AkashaTemporalStateSnapshot,
	buildCachedAkashaTemporalStateSnapshot,
} from "./projection-cache.js";
import type { AkashaSemanticMemorySeed } from "./semantic-memory-seed.js";
import { type AkashaToolGateDecision, evaluateAkashaToolGate } from "./tool-gate.js";
import type { AkashaEvent, AkashaEventDraft, AkashaStore } from "./types.js";
import { buildAkashaUserTimeline } from "./user-timeline.js";

const MAX_ACTION_GATE_TOKEN_ESTIMATE = 4000;

export interface AkashaTemporalKernelOptions {
	store: AkashaStore;
	sessionId: string;
	streamId: string;
	agentDir: string;
	eventLogDir?: string;
	reflection: ResolvedAkashaReflectionSettings;
	policyRules?: AkashaPolicyRule[];
}

export interface AkashaActionContextBuildOptions {
	cwd: string;
	settings: ResolvedAkashaActionGateSettings;
	holographicMemory?: ResolvedAkashaHolographicMemorySettings;
	latestUserText?: string;
	pendingInboxItemIds?: string[];
	strictRepairMissingEventIds?: string[];
	semanticMemorySeeds?: AkashaSemanticMemorySeed[];
	parentEventIds?: string[];
	correlationId?: string;
	turnEventId?: string;
	sourceKey?: string;
	eventTime?: string;
}

export interface AkashaActionContextBuildResult {
	gate?: AkashaActionGateContext;
	auditEvent?: AkashaEvent;
	recalledEvent?: AkashaEvent;
	memoryField?: AkashaReconstructedMemoryField;
}

export interface AkashaRuntimePolicyEvaluationOptions {
	action: AkashaRuntimePolicyAction;
	parentEventIds?: string[];
	correlationId?: string;
	sourceKey?: string;
	eventTime?: string;
}

export interface AkashaRuntimePolicyEvaluationResult {
	decision: AkashaPolicyDecision;
	event: AkashaEvent;
}

export class AkashaTemporalKernel {
	private readonly store: AkashaStore;
	private readonly sessionId: string;
	private readonly streamId: string;
	private readonly agentDir: string;
	private readonly eventLogDir?: string;
	private readonly reflection: ResolvedAkashaReflectionSettings;
	private readonly policyRules?: AkashaPolicyRule[];

	constructor(options: AkashaTemporalKernelOptions) {
		this.store = options.store;
		this.sessionId = options.sessionId;
		this.streamId = options.streamId;
		this.agentDir = options.agentDir;
		this.eventLogDir = options.eventLogDir;
		this.reflection = options.reflection;
		this.policyRules = options.policyRules;
	}

	append(draft: AkashaEventDraft): AkashaEvent {
		return this.store.append(draft);
	}

	buildState(limit = 1000): AkashaTemporalStateSnapshot {
		return this.buildStateWithCache(limit).value;
	}

	buildStateWithCache(limit = 1000): AkashaCachedProjectionResult<AkashaTemporalStateSnapshot> {
		return buildCachedAkashaTemporalStateSnapshot(this.store, {
			agentDir: this.agentDir,
			eventLogDir: this.eventLogDir,
			limit,
		});
	}

	buildActionContext(options: AkashaActionContextBuildOptions): AkashaActionContextBuildResult {
		const sessionEvents = this.store.buildTimeline({ limit: 500 });
		const projectTimeline = options.settings.includeProjectState
			? buildAkashaProjectTimeline({
					agentDir: this.agentDir,
					eventLogDir: this.eventLogDir,
					cwd: options.cwd,
					limit: 1000,
				})
			: undefined;
		const userTimeline = options.settings.includeUserTimeline
			? buildAkashaUserTimeline({
					agentDir: this.agentDir,
					eventLogDir: this.eventLogDir,
					limit: 1000,
				})
			: undefined;
		const rawMemoryField = this.buildHolographicMemoryField({
			sessionEvents,
			projectTimeline,
			userTimeline,
			settings: options.holographicMemory,
			latestUserText: options.latestUserText,
			cwd: options.cwd,
			pendingInboxItemIds: options.pendingInboxItemIds,
			strictRepairMissingEventIds: options.strictRepairMissingEventIds,
			semanticMemorySeeds: options.semanticMemorySeeds,
			eventTime: options.eventTime,
		});
		const memoryGovernance = rawMemoryField
			? projectAkashaGovernedEvents(projectTimeline?.events ?? sessionEvents)
			: undefined;
		const memoryRecallBlockedSources =
			rawMemoryField && memoryGovernance
				? intersectStrings(rawMemoryField.sourceEventIds, [
						...memoryGovernance.suppressedEventIds,
						...memoryGovernance.redactedSourceEventIds,
						...memoryGovernance.omittedDerivedEventIds,
					])
				: [];
		const memoryRecallPolicy = rawMemoryField
			? this.evaluateRuntimePolicy({
					action: {
						type: "memory_recall",
						subject: "akasha.holographic_memory",
						objectId: rawMemoryField.fieldId,
						payload: {
							recalledEventIds: rawMemoryField.recalledEventIds,
							recalledTraceIds: rawMemoryField.recalledTraceIds,
							recalledEdgeIds: rawMemoryField.recalledEdgeIds,
							semanticSeedEventIds: rawMemoryField.semanticSeedEventIds,
							tokenEstimate: rawMemoryField.tokenEstimate,
							suppressedSourceEventIds: memoryRecallBlockedSources,
							governanceSuppressedEventIds: memoryGovernance?.suppressedEventIds ?? [],
							governanceRedactedSourceEventIds: memoryGovernance?.redactedSourceEventIds ?? [],
							governanceOmittedDerivedEventIds: memoryGovernance?.omittedDerivedEventIds ?? [],
						},
					},
					parentEventIds: options.parentEventIds ?? [],
					correlationId: options.correlationId,
					sourceKey: options.sourceKey ? `${options.sourceKey}:memory-recall-policy` : undefined,
					eventTime: options.eventTime,
				})
			: undefined;
		const memoryField = memoryRecallPolicy?.decision.action === "allow" ? rawMemoryField : undefined;
		const gate = buildAkashaActionGateContext({
			sessionEvents,
			projectTimeline,
			userTimeline,
			holographicMemory: memoryField,
			maxItems: options.settings.maxItems,
			now: options.eventTime,
		});
		if (!gate) return {};
		const policy = this.evaluateRuntimePolicy({
			action: {
				type: "context_injection",
				subject: "akasha.action_gate",
				objectId: "akasha.action_gate",
				payload: {
					eventIds: gate.eventIds,
					sections: gate.sections,
					tokenEstimate: gate.tokenEstimate,
					maxTokenEstimate: MAX_ACTION_GATE_TOKEN_ESTIMATE,
					currentStateIds: gate.temporalValidity?.currentStateIds ?? [],
					staleStateIds: gate.temporalValidity?.staleStateIds ?? [],
					staleEphemeralStateIds: gate.temporalValidity?.staleEphemeralStateIds ?? [],
					staleHealthStateIds: gate.temporalValidity?.staleHealthStateIds ?? [],
					currentnessCheckCount: gate.temporalValidity?.currentnessCheckCount ?? 0,
				},
			},
			parentEventIds: [memoryRecallPolicy?.event.eventId, ...(options.parentEventIds ?? [])].filter(
				(id): id is string => typeof id === "string",
			),
			correlationId: options.correlationId,
			sourceKey: options.sourceKey ? `${options.sourceKey}:policy` : undefined,
			eventTime: options.eventTime,
		});
		if (policy.decision.action !== "allow") return {};
		const recalledEvent =
			memoryField && options.holographicMemory?.recordRecallEvents
				? this.store.append(
						createMemoryRecalledDraft({
							sessionId: this.sessionId,
							streamId: this.streamId,
							cue: memoryField.cue,
							field: memoryField,
							parentEventIds: [
								policy.event.eventId,
								memoryRecallPolicy?.event.eventId,
								...(options.parentEventIds ?? []),
								...memoryField.sourceEventIds.slice(0, 8),
							].filter((id): id is string => typeof id === "string"),
							correlationId: options.correlationId,
							sourceKey: options.sourceKey ? `${options.sourceKey}:memory-recalled` : undefined,
							eventTime: options.eventTime,
							scope: createAkashaMemoryRecallScope({
								turnId: options.turnEventId ?? options.correlationId,
								correlationId: options.correlationId,
								expiresAfterTurn: true,
							}),
						}),
					)
				: undefined;

		const auditEvent = this.store.append({
			kind: "action_gate.injected",
			sessionId: this.sessionId,
			streamId: this.streamId,
			eventTime: options.eventTime ?? new Date().toISOString(),
			actor: "system",
			subjectId: "akasha.action_gate",
			sourceKey: options.sourceKey,
			parentEventIds: [policy.event.eventId, recalledEvent?.eventId, ...(options.parentEventIds ?? [])].filter(
				(id): id is string => typeof id === "string",
			),
			correlationId: options.correlationId,
			payload: {
				contentHash: hashText(gate.text),
				eventIds: gate.eventIds,
				sections: gate.sections,
				tokenEstimate: gate.tokenEstimate,
				temporalValidity: gate.temporalValidity,
			},
			importance: 0.65,
			ttlPolicy: "long_term",
		});
		return { gate, auditEvent, recalledEvent, memoryField };
	}

	private buildHolographicMemoryField(input: {
		sessionEvents: AkashaEvent[];
		projectTimeline?: ReturnType<typeof buildAkashaProjectTimeline>;
		userTimeline?: ReturnType<typeof buildAkashaUserTimeline>;
		settings?: ResolvedAkashaHolographicMemorySettings;
		latestUserText?: string;
		cwd: string;
		pendingInboxItemIds?: string[];
		strictRepairMissingEventIds?: string[];
		semanticMemorySeeds?: AkashaSemanticMemorySeed[];
		eventTime?: string;
	}): AkashaReconstructedMemoryField | undefined {
		const settings = input.settings;
		if (!settings?.enabled || !settings.injectIntoActionGate) return undefined;
		const events = input.projectTimeline?.events ?? input.sessionEvents;
		const traceLimit = 1000;
		const sourceLogPaths = input.projectTimeline
			? input.projectTimeline.sessions.map((session) => session.eventLogPath)
			: [this.store.eventLogPath];
		const projectionScope = input.projectTimeline ? "project" : "session";
		const projectionScopeKey = input.projectTimeline ? `project:${input.cwd}` : `session:${this.store.eventLogPath}`;
		const traces = input.projectTimeline
			? buildCachedAkashaMemoryTracesFromEvents(events, {
					agentDir: this.agentDir,
					eventLogDir: this.eventLogDir,
					scope: projectionScope,
					cacheKey: memoryTraceProjectionCacheKeyForScope(`project:${input.cwd}`, traceLimit),
					sourceLogPaths,
					limit: traceLimit,
				}).value
			: buildCachedAkashaMemoryTraces(this.store, {
					agentDir: this.agentDir,
					eventLogDir: this.eventLogDir,
					limit: traceLimit,
				}).value;
		if (traces.length === 0) return undefined;
		const edges = buildCachedAkashaMemoryTraceEdgesFromEvents(events, traces, {
			agentDir: this.agentDir,
			eventLogDir: this.eventLogDir,
			scope: projectionScope,
			cacheKey: memoryTraceEdgeProjectionCacheKeyForScope(projectionScopeKey, traceLimit),
			sourceLogPaths,
			limit: traceLimit,
		}).value;
		const cue = buildAkashaMemoryCue({
			latestUserText: input.latestUserText,
			cwd: input.cwd,
			sessionEvents: input.sessionEvents,
			projectTimeline: input.projectTimeline,
			userTimeline: input.userTimeline,
			pendingInboxItemIds: input.pendingInboxItemIds,
			strictRepairMissingEventIds: input.strictRepairMissingEventIds,
			now: input.eventTime,
		});
		const field = reconstructAkashaMemoryField({
			events,
			traces,
			edges,
			cue,
			semanticSeeds: input.semanticMemorySeeds,
			options: {
				maxTraces: settings.maxTraces,
				maxEpisodes: settings.maxEpisodes,
				maxLessons: settings.maxLessons,
				maxProcedures: settings.maxProcedures,
				maxWarnings: settings.maxWarnings,
				now: input.eventTime ? new Date(input.eventTime) : undefined,
			},
		});
		if (
			field.episodes.length === 0 &&
			field.lessons.length === 0 &&
			field.procedures.length === 0 &&
			field.warnings.length === 0 &&
			field.contextualValidityAnnotations.length === 0
		) {
			return undefined;
		}
		return field;
	}

	evaluatePolicy(event: ToolCallEvent, settings: ResolvedAkashaActionGateSettings): AkashaToolGateDecision {
		return evaluateAkashaToolGate(event, {
			settings,
			timelineEvents: this.store.buildTimeline({ limit: 500 }),
		});
	}

	evaluateRuntimePolicy(options: AkashaRuntimePolicyEvaluationOptions): AkashaRuntimePolicyEvaluationResult {
		const action = withDefaultRules(options.action, this.policyRules);
		const decision = evaluateAkashaRuntimePolicy(action);
		const eventTime = options.eventTime ?? new Date().toISOString();
		const event = this.store.append({
			kind: "policy.evaluated",
			sessionId: this.sessionId,
			streamId: this.streamId,
			eventTime,
			actor: "system",
			subjectId: "akasha.policy_kernel",
			objectId: action.objectId ?? action.subject ?? action.type,
			sourceKey:
				options.sourceKey ??
				`runtime-policy:${this.sessionId}:${action.type}:${action.subject ?? "action"}:${eventTime}`,
			parentEventIds: options.parentEventIds ?? [],
			correlationId: options.correlationId,
			payload: createPolicyEvaluatedPayload(
				{
					actionType: options.action.type,
					subject: action.subject,
					objectId: action.objectId,
					payload: action.payload,
					evidenceEvents: action.evidenceEvents,
					rules: action.rules,
					now: action.now,
				},
				decision,
			),
			importance: decision.action === "allow" ? 0.45 : 0.85,
			ttlPolicy: "long_term",
		});
		return { decision, event };
	}

	runDaemonPass(now?: Date): AkashaDaemonQueuePassResult {
		return runAkashaDaemonQueuePass(this.store, {
			reflection: this.reflection,
			now,
		});
	}

	runCallbackRunner(options: Omit<AkashaCallbackRunnerOptions, "reflection"> = {}): AkashaCallbackRunnerResult {
		return runAkashaCallbackRunner(this.store, {
			...options,
			agentDir: options.agentDir ?? this.agentDir,
			rules: options.rules ?? this.policyRules,
			reflection: this.reflection,
		});
	}

	scheduleCallback(options: Omit<AkashaCallbackDraftOptions, "sessionId" | "streamId">): AkashaEvent {
		return this.store.append(
			createCallbackScheduledDraft({
				...options,
				sessionId: this.sessionId,
				streamId: this.streamId,
			}),
		);
	}

	markCallbackCompleted(callbackId: string, evidenceEventId?: string): AkashaEvent {
		return markAkashaCallbackCompleted(this.store, callbackId, { evidenceEventId });
	}

	markCallbackCancelled(callbackId: string, reason?: string): AkashaEvent {
		return markAkashaCallbackCancelled(this.store, callbackId, { reason });
	}
}

export function createAkashaTemporalKernel(options: AkashaTemporalKernelOptions): AkashaTemporalKernel {
	return new AkashaTemporalKernel(options);
}

export function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function withDefaultRules(
	action: AkashaRuntimePolicyAction,
	rules: AkashaPolicyRule[] | undefined,
): AkashaRuntimePolicyAction {
	if (action.rules !== undefined || rules === undefined) return action;
	return { ...action, rules };
}

function intersectStrings(left: string[], right: string[]): string[] {
	const rightSet = new Set(right);
	return [...new Set(left.filter((value) => rightSet.has(value)))];
}
