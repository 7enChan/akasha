import type { ResolvedAkashaReflectionSettings } from "../settings-manager.js";
import { appendAkashaPendingCallbackPrompt } from "./callback-inbox.js";
import type { AkashaDaemonQueuePassResult } from "./daemon-queue.js";
import { runAkashaDaemonQueuePass } from "./daemon-queue.js";
import {
	type AkashaPolicyDecision,
	type AkashaPolicyRule,
	createPolicyEvaluatedPayload,
	evaluateAkashaRuntimePolicy,
} from "./policy-kernel.js";
import type { AkashaEvent, AkashaStore } from "./types.js";

export type AkashaCallbackDispatchMode = "record_only" | "terminal_notification" | "agent_prompt_file" | "agent";

export interface AkashaCallbackDispatchContext {
	store: AkashaStore;
	callback: AkashaRunnableCallback;
	claim: AkashaEvent;
	now: Date;
	agentDir?: string;
}

export interface AkashaCallbackDispatchResult {
	status: "dispatched" | "failed";
	mode: AkashaCallbackDispatchMode;
	message: string;
	outputEventIds?: string[];
	details?: Record<string, unknown>;
}

export interface AkashaCallbackDispatcher {
	name: AkashaCallbackDispatchMode;
	dispatch(context: AkashaCallbackDispatchContext): AkashaCallbackDispatchResult;
}

export interface AkashaCallbackRunnerOptions {
	reflection: ResolvedAkashaReflectionSettings;
	now?: Date;
	limit?: number;
	maxCallbacks?: number;
	dispatchMode?: AkashaCallbackDispatchMode;
	dispatcher?: AkashaCallbackDispatcher;
	agentDir?: string;
	rules?: AkashaPolicyRule[];
}

export interface AkashaRunnableCallback {
	callbackId: string;
	dueEvent: AkashaEvent;
	claimEvent?: AkashaEvent;
	summary: string;
	targetEventId?: string;
	kind?: string;
}

export interface AkashaCallbackRunnerResult {
	daemon: AkashaDaemonQueuePassResult;
	pending: AkashaRunnableCallback[];
	claimed: AkashaEvent[];
	dispatched: AkashaEvent[];
	failed: AkashaEvent[];
	policies: Array<{ decision: AkashaPolicyDecision; event: AkashaEvent }>;
}

export function runAkashaCallbackRunner(
	store: AkashaStore,
	options: AkashaCallbackRunnerOptions,
): AkashaCallbackRunnerResult {
	const now = options.now ?? new Date();
	const daemon = runAkashaDaemonQueuePass(store, {
		reflection: options.reflection,
		now,
	});
	const pending = buildRunnableCallbacks(
		store.buildTimeline({ limit: options.limit ?? Number.MAX_SAFE_INTEGER }),
	).slice(0, options.maxCallbacks ?? 10);
	const claimed: AkashaEvent[] = [];
	const dispatched: AkashaEvent[] = [];
	const failed: AkashaEvent[] = [];
	const policies: AkashaCallbackRunnerResult["policies"] = [];

	for (const callback of pending) {
		const claim = callback.claimEvent ?? claimAkashaCallback(store, callback, now);
		if (!callback.claimEvent) claimed.push(claim);
		const policy = appendCallbackDispatchPolicy(store, callback, claim, options, now);
		policies.push(policy);
		if (policy.decision.action !== "allow") {
			failed.push(failAkashaCallbackDispatch(store, callback, claim, policy.event, policy.decision.reason, now));
			continue;
		}
		const dispatchResult = (
			options.dispatcher ?? createAkashaCallbackDispatcher(options.dispatchMode ?? "record_only")
		).dispatch({
			store,
			callback,
			claim,
			now,
			agentDir: options.agentDir,
		});
		if (dispatchResult.status === "failed") {
			failed.push(
				failAkashaCallbackDispatch(
					store,
					callback,
					claim,
					policy.event,
					dispatchResult.message,
					now,
					dispatchResult,
				),
			);
			continue;
		}
		dispatched.push(dispatchAkashaCallback(store, callback, claim, dispatchResult, now));
	}

	return {
		daemon,
		pending,
		claimed,
		dispatched,
		failed,
		policies,
	};
}

export function createAkashaCallbackDispatcher(mode: AkashaCallbackDispatchMode): AkashaCallbackDispatcher {
	const normalizedMode = mode === "agent" ? "agent_prompt_file" : mode;
	if (normalizedMode === "terminal_notification") {
		return {
			name: "terminal_notification",
			dispatch: ({ callback }) => ({
				status: "dispatched",
				mode: "terminal_notification",
				message: `Akasha callback due: ${callback.summary}`,
			}),
		};
	}
	if (normalizedMode === "agent_prompt_file") {
		return {
			name: "agent_prompt_file",
			dispatch: ({ callback, claim, now, agentDir }) => {
				if (!agentDir) {
					return {
						status: "failed",
						mode: "agent_prompt_file",
						message: "agent_prompt_file dispatch requires agentDir",
					};
				}
				const prompt = appendAkashaPendingCallbackPrompt(agentDir, callback, claim, now);
				return {
					status: "dispatched",
					mode: "agent_prompt_file",
					message: `Queued callback prompt: ${prompt.id}`,
					details: {
						inboxItemId: prompt.id,
						prompt: prompt.prompt,
					},
				};
			},
		};
	}
	return {
		name: "record_only",
		dispatch: ({ callback }) => ({
			status: "dispatched",
			mode: "record_only",
			message: `Recorded callback dispatch: ${callback.callbackId}`,
		}),
	};
}

export function buildRunnableCallbacks(events: AkashaEvent[]): AkashaRunnableCallback[] {
	const byCallbackId = new Map<string, AkashaEvent[]>();
	for (const event of events) {
		const callbackId = callbackIdOf(event);
		if (!callbackId) continue;
		const list = byCallbackId.get(callbackId) ?? [];
		list.push(event);
		byCallbackId.set(callbackId, list);
	}

	const callbacks: AkashaRunnableCallback[] = [];
	for (const [callbackId, callbackEvents] of byCallbackId) {
		const terminal = callbackEvents.find(
			(event) => event.kind === "time.callback.completed" || event.kind === "time.callback.cancelled",
		);
		if (terminal) continue;
		const dispatched = callbackEvents.find((event) => event.kind === "time.callback.dispatched");
		const failed = callbackEvents.find((event) => event.kind === "time.callback.failed");
		if (dispatched || failed) continue;
		const dueEvent = [...callbackEvents].reverse().find((event) => event.kind === "time.callback.due");
		if (!dueEvent) continue;
		callbacks.push({
			callbackId,
			dueEvent,
			claimEvent: [...callbackEvents].reverse().find((event) => event.kind === "time.callback.claimed"),
			summary: stringPayload(dueEvent, "summary") ?? callbackId,
			targetEventId: stringPayload(dueEvent, "targetEventId") ?? dueEvent.objectId,
			kind: stringPayload(dueEvent, "kind"),
		});
	}
	return callbacks.sort((a, b) => a.dueEvent.eventTime.localeCompare(b.dueEvent.eventTime));
}

function claimAkashaCallback(store: AkashaStore, callback: AkashaRunnableCallback, now: Date): AkashaEvent {
	return store.append({
		kind: "time.callback.claimed",
		sessionId: callback.dueEvent.sessionId,
		streamId: callback.dueEvent.streamId,
		eventTime: now.toISOString(),
		actor: "system",
		subjectId: "akasha.callback_runner",
		objectId: callback.targetEventId,
		sourceKey: `time-callback-claimed:${callback.callbackId}:${callback.dueEvent.eventId}`,
		parentEventIds: [callback.dueEvent.eventId],
		payload: {
			callbackId: callback.callbackId,
			dueEventId: callback.dueEvent.eventId,
			kind: callback.kind,
			summary: callback.summary,
			targetEventId: callback.targetEventId,
		},
		importance: 0.75,
		ttlPolicy: "long_term",
	});
}

function dispatchAkashaCallback(
	store: AkashaStore,
	callback: AkashaRunnableCallback,
	claim: AkashaEvent,
	dispatchResult: AkashaCallbackDispatchResult,
	now: Date,
): AkashaEvent {
	return store.append({
		kind: "time.callback.dispatched",
		sessionId: claim.sessionId,
		streamId: claim.streamId,
		eventTime: now.toISOString(),
		actor: "system",
		subjectId: "akasha.callback_runner",
		objectId: callback.targetEventId,
		sourceKey: `time-callback-dispatched:${callback.callbackId}:${claim.eventId}`,
		parentEventIds: [claim.eventId],
		payload: {
			callbackId: callback.callbackId,
			claimEventId: claim.eventId,
			dueEventId: callback.dueEvent.eventId,
			dispatchMode: dispatchResult.mode,
			dispatcherMessage: dispatchResult.message,
			outputEventIds: dispatchResult.outputEventIds,
			dispatchDetails: dispatchResult.details,
			kind: callback.kind,
			summary: callback.summary,
			targetEventId: callback.targetEventId,
		},
		importance: 0.8,
		ttlPolicy: "long_term",
	});
}

function failAkashaCallbackDispatch(
	store: AkashaStore,
	callback: AkashaRunnableCallback,
	claim: AkashaEvent,
	policyEvent: AkashaEvent,
	reason: string,
	now: Date,
	dispatchResult?: AkashaCallbackDispatchResult,
): AkashaEvent {
	return store.append({
		kind: "time.callback.failed",
		sessionId: claim.sessionId,
		streamId: claim.streamId,
		eventTime: now.toISOString(),
		actor: "system",
		subjectId: "akasha.callback_runner",
		objectId: callback.targetEventId,
		sourceKey: `time-callback-failed:${callback.callbackId}:${policyEvent.eventId}`,
		parentEventIds: [claim.eventId, policyEvent.eventId],
		payload: {
			callbackId: callback.callbackId,
			claimEventId: claim.eventId,
			dueEventId: callback.dueEvent.eventId,
			reason,
			dispatchMode: dispatchResult?.mode,
			dispatcherMessage: dispatchResult?.message,
			dispatchDetails: dispatchResult?.details,
			kind: callback.kind,
			summary: callback.summary,
			targetEventId: callback.targetEventId,
		},
		importance: 0.85,
		ttlPolicy: "long_term",
	});
}

function appendCallbackDispatchPolicy(
	store: AkashaStore,
	callback: AkashaRunnableCallback,
	claim: AkashaEvent,
	options: AkashaCallbackRunnerOptions,
	now: Date,
): { decision: AkashaPolicyDecision; event: AkashaEvent } {
	const decision = evaluateAkashaRuntimePolicy({
		type: "callback_dispatch",
		subject: callback.kind ?? "callback",
		objectId: callback.targetEventId ?? callback.callbackId,
		payload: {
			callbackId: callback.callbackId,
			kind: callback.kind,
			summary: callback.summary,
			targetEventId: callback.targetEventId,
			dispatchMode: options.dispatchMode ?? "record_only",
		},
		rules: options.rules,
		now,
	});
	const event = store.append({
		kind: "policy.evaluated",
		sessionId: claim.sessionId,
		streamId: claim.streamId,
		eventTime: now.toISOString(),
		actor: "system",
		subjectId: "akasha.policy_kernel",
		objectId: callback.targetEventId ?? callback.callbackId,
		sourceKey: `callback-dispatch-policy:${callback.callbackId}:${claim.eventId}`,
		parentEventIds: [claim.eventId],
		payload: createPolicyEvaluatedPayload(
			{
				actionType: "callback_dispatch",
				subject: callback.kind ?? "callback",
				objectId: callback.targetEventId ?? callback.callbackId,
				payload: {
					callbackId: callback.callbackId,
					kind: callback.kind,
					summary: callback.summary,
					targetEventId: callback.targetEventId,
					dispatchMode: options.dispatchMode ?? "record_only",
				},
				rules: options.rules,
				now,
			},
			decision,
		),
		importance: decision.action === "allow" ? 0.5 : 0.9,
		ttlPolicy: "long_term",
	});
	return { decision, event };
}

function callbackIdOf(event: AkashaEvent): string | undefined {
	return typeof event.payload.callbackId === "string" ? event.payload.callbackId : undefined;
}

function stringPayload(event: AkashaEvent, key: string): string | undefined {
	return typeof event.payload[key] === "string" ? event.payload[key] : undefined;
}
