import { createHash } from "node:crypto";
import type { ToolCallEvent } from "../extensions/types.js";
import type { ResolvedAkashaActionGateSettings, ResolvedAkashaReflectionSettings } from "../settings-manager.js";
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
import {
	type AkashaPolicyDecision,
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
import { type AkashaToolGateDecision, evaluateAkashaToolGate } from "./tool-gate.js";
import type { AkashaEvent, AkashaEventDraft, AkashaStore } from "./types.js";
import { buildAkashaUserTimeline } from "./user-timeline.js";

export interface AkashaTemporalKernelOptions {
	store: AkashaStore;
	sessionId: string;
	streamId: string;
	agentDir: string;
	eventLogDir?: string;
	reflection: ResolvedAkashaReflectionSettings;
}

export interface AkashaActionContextBuildOptions {
	cwd: string;
	settings: ResolvedAkashaActionGateSettings;
	parentEventIds?: string[];
	correlationId?: string;
	sourceKey?: string;
	eventTime?: string;
}

export interface AkashaActionContextBuildResult {
	gate?: AkashaActionGateContext;
	auditEvent?: AkashaEvent;
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

	constructor(options: AkashaTemporalKernelOptions) {
		this.store = options.store;
		this.sessionId = options.sessionId;
		this.streamId = options.streamId;
		this.agentDir = options.agentDir;
		this.eventLogDir = options.eventLogDir;
		this.reflection = options.reflection;
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
		const gate = buildAkashaActionGateContext({
			sessionEvents: this.store.buildTimeline({ limit: 500 }),
			projectTimeline,
			userTimeline,
			maxItems: options.settings.maxItems,
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
				},
			},
			parentEventIds: options.parentEventIds ?? [],
			correlationId: options.correlationId,
			sourceKey: options.sourceKey ? `${options.sourceKey}:policy` : undefined,
			eventTime: options.eventTime,
		});
		if (policy.decision.action !== "allow") return {};

		const auditEvent = this.store.append({
			kind: "action_gate.injected",
			sessionId: this.sessionId,
			streamId: this.streamId,
			eventTime: options.eventTime ?? new Date().toISOString(),
			actor: "system",
			subjectId: "akasha.action_gate",
			sourceKey: options.sourceKey,
			parentEventIds: [policy.event.eventId, ...(options.parentEventIds ?? [])],
			correlationId: options.correlationId,
			payload: {
				contentHash: hashText(gate.text),
				eventIds: gate.eventIds,
				sections: gate.sections,
				tokenEstimate: gate.tokenEstimate,
			},
			importance: 0.65,
			ttlPolicy: "long_term",
		});
		return { gate, auditEvent };
	}

	evaluatePolicy(event: ToolCallEvent, settings: ResolvedAkashaActionGateSettings): AkashaToolGateDecision {
		return evaluateAkashaToolGate(event, {
			settings,
			timelineEvents: this.store.buildTimeline({ limit: 500 }),
		});
	}

	evaluateRuntimePolicy(options: AkashaRuntimePolicyEvaluationOptions): AkashaRuntimePolicyEvaluationResult {
		const decision = evaluateAkashaRuntimePolicy(options.action);
		const eventTime = options.eventTime ?? new Date().toISOString();
		const event = this.store.append({
			kind: "policy.evaluated",
			sessionId: this.sessionId,
			streamId: this.streamId,
			eventTime,
			actor: "system",
			subjectId: "akasha.policy_kernel",
			objectId: options.action.objectId ?? options.action.subject ?? options.action.type,
			sourceKey:
				options.sourceKey ??
				`runtime-policy:${this.sessionId}:${options.action.type}:${options.action.subject ?? "action"}:${eventTime}`,
			parentEventIds: options.parentEventIds ?? [],
			correlationId: options.correlationId,
			payload: createPolicyEvaluatedPayload(
				{
					actionType: options.action.type,
					subject: options.action.subject,
					objectId: options.action.objectId,
					payload: options.action.payload,
					evidenceEvents: options.action.evidenceEvents,
					rules: options.action.rules,
					now: options.action.now,
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
