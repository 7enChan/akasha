import type { ResolvedAkashaReflectionSettings } from "../settings-manager.js";
import type { AkashaDaemonQueuePassResult } from "./daemon-queue.js";
import { runAkashaDaemonQueuePass } from "./daemon-queue.js";
import {
	type AkashaPolicyDecision,
	type AkashaPolicyRule,
	createPolicyEvaluatedPayload,
	evaluateAkashaRuntimePolicy,
} from "./policy-kernel.js";
import type { AkashaEvent, AkashaStore } from "./types.js";

export interface AkashaCallbackRunnerOptions {
	reflection: ResolvedAkashaReflectionSettings;
	now?: Date;
	limit?: number;
	maxCallbacks?: number;
	dispatchMode?: "record_only" | "agent";
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
		dispatched.push(dispatchAkashaCallback(store, callback, claim, options.dispatchMode ?? "record_only", now));
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
	dispatchMode: "record_only" | "agent",
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
			dispatchMode,
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
