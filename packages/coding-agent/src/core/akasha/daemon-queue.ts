import type { ResolvedAkashaReflectionSettings } from "../settings-manager.js";
import { buildKarmaLedger } from "./karma-ledger.js";
import { orderAkashaEvents } from "./ordering.js";
import { decideReflection } from "./reflection-policy.js";
import { planAkashaRetention } from "./retention.js";
import type { AkashaEvent, AkashaEventDraft, AkashaStore } from "./types.js";

export type AkashaCallbackKind = "promise_due" | "prediction_due" | "retention_due" | "reflection_due";

export interface AkashaDaemonQueueItem {
	callbackId: string;
	kind: AkashaCallbackKind;
	dueTime: string;
	summary: string;
	targetEventId?: string;
	importance: number;
}

export interface AkashaDaemonQueueOptions {
	now?: Date;
	reflection: ResolvedAkashaReflectionSettings;
}

export interface AkashaDaemonQueuePassResult {
	tick: AkashaEvent;
	dueCallbacks: AkashaEvent[];
	queue: AkashaDaemonQueueItem[];
}

export function buildAkashaDaemonQueue(
	events: AkashaEvent[],
	options: AkashaDaemonQueueOptions,
): AkashaDaemonQueueItem[] {
	const now = options.now ?? new Date();
	const ordered = orderAkashaEvents(events);
	const ledger = buildKarmaLedger(ordered, now);
	const retention = planAkashaRetention(ordered, now);
	const reflection = decideReflection(ordered, options.reflection, now);
	const completed = completedCallbackIds(ordered);
	const existingDue = dueCallbackIds(ordered);
	const queue: AkashaDaemonQueueItem[] = [];

	for (const promise of ledger.promises) {
		if (promise.state !== "overdue") continue;
		queue.push({
			callbackId: `promise:${promise.promiseId}:${promise.dueTime ?? promise.createdTime}`,
			kind: "promise_due",
			dueTime: promise.dueTime ?? now.toISOString(),
			summary: `Promise due: ${promise.summary}`,
			targetEventId: promise.lastEventId,
			importance: 0.85,
		});
	}

	for (const prediction of ledger.predictions) {
		if (prediction.state !== "due") continue;
		queue.push({
			callbackId: `prediction:${prediction.predictionId}:${prediction.checkAfter ?? prediction.createdTime}`,
			kind: "prediction_due",
			dueTime: prediction.checkAfter ?? now.toISOString(),
			summary: `Prediction due: ${prediction.claim}`,
			targetEventId: prediction.lastEventId,
			importance: 0.85,
		});
	}

	for (const decision of retention.decisions) {
		if (decision.action === "keep") continue;
		queue.push({
			callbackId: `retention:${decision.eventId}:${decision.action}`,
			kind: "retention_due",
			dueTime: now.toISOString(),
			summary: `Retention due: ${decision.action} ${decision.eventId}`,
			targetEventId: decision.eventId,
			importance: 0.65,
		});
	}

	if (reflection.shouldRun) {
		const last = ordered.at(-1);
		queue.push({
			callbackId: `reflection:${last?.eventId ?? "empty"}:${reflection.reason}`,
			kind: "reflection_due",
			dueTime: now.toISOString(),
			summary: `Reflection due: ${reflection.reason}`,
			targetEventId: last?.eventId,
			importance: 0.6,
		});
	}

	return queue
		.filter((item) => !completed.has(item.callbackId) && !existingDue.has(item.callbackId))
		.sort((a, b) => a.dueTime.localeCompare(b.dueTime) || b.importance - a.importance);
}

export function runAkashaDaemonQueuePass(
	store: AkashaStore,
	options: AkashaDaemonQueueOptions,
): AkashaDaemonQueuePassResult {
	const now = options.now ?? new Date();
	const events = store.buildTimeline({ limit: Number.MAX_SAFE_INTEGER });
	const sessionId = events.at(-1)?.sessionId ?? "unknown";
	const streamId = events.at(-1)?.streamId ?? `session:${sessionId}`;
	const queue = buildAkashaDaemonQueue(events, { ...options, now });
	const tick = store.append({
		kind: "daemon.tick",
		sessionId,
		streamId,
		eventTime: now.toISOString(),
		actor: "system",
		subjectId: "akasha.daemon",
		sourceKey: `daemon-tick:${sessionId}:${now.toISOString()}`,
		parentEventIds: events.at(-1) ? [events.at(-1)!.eventId] : [],
		payload: {
			queueCount: queue.length,
			dueCallbackIds: queue.map((item) => item.callbackId),
		},
		importance: 0.45,
		ttlPolicy: "session",
	});
	const dueCallbacks = queue.map((item) =>
		store.append(toCallbackDueDraft(item, sessionId, streamId, tick.eventId, now)),
	);
	return { tick, dueCallbacks, queue };
}

function toCallbackDueDraft(
	item: AkashaDaemonQueueItem,
	sessionId: string,
	streamId: string,
	tickEventId: string,
	now: Date,
): AkashaEventDraft {
	return {
		kind: "time.callback.due",
		sessionId,
		streamId,
		eventTime: now.toISOString(),
		actor: "system",
		subjectId: "akasha.daemon",
		objectId: item.targetEventId,
		sourceKey: `time-callback-due:${item.callbackId}`,
		parentEventIds: item.targetEventId ? [tickEventId, item.targetEventId] : [tickEventId],
		payload: {
			callbackId: item.callbackId,
			kind: item.kind,
			dueTime: item.dueTime,
			summary: item.summary,
			targetEventId: item.targetEventId,
		},
		importance: item.importance,
		ttlPolicy: "long_term",
	};
}

function dueCallbackIds(events: AkashaEvent[]): Set<string> {
	return new Set(
		events.flatMap((event) =>
			event.kind === "time.callback.due" && typeof event.payload.callbackId === "string"
				? [event.payload.callbackId]
				: [],
		),
	);
}

function completedCallbackIds(events: AkashaEvent[]): Set<string> {
	return new Set(
		events.flatMap((event) =>
			event.kind === "time.callback.completed" && typeof event.payload.callbackId === "string"
				? [event.payload.callbackId]
				: [],
		),
	);
}
