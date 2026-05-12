import type { ResolvedAkashaReflectionSettings } from "../settings-manager.js";
import { buildKarmaLedger } from "./karma-ledger.js";
import { orderAkashaEvents } from "./ordering.js";
import { decideReflection } from "./reflection-policy.js";
import { planAkashaRetention } from "./retention.js";
import type { AkashaEvent, AkashaEventDraft, AkashaStore } from "./types.js";

export type AkashaCallbackKind =
	| "promise_due"
	| "prediction_due"
	| "retention_due"
	| "reflection_due"
	| "scheduled_callback";

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
	scheduledCallbacks: AkashaEvent[];
	dueCallbacks: AkashaEvent[];
	queue: AkashaDaemonQueueItem[];
}

export interface AkashaCallbackDraftOptions {
	sessionId: string;
	streamId: string;
	callbackId: string;
	kind: AkashaCallbackKind;
	dueTime: string;
	summary: string;
	targetEventId?: string;
	parentEventIds?: string[];
	eventTime?: string;
	actor?: AkashaEvent["actor"];
	subjectId?: string;
	sourceKey?: string;
	importance?: number;
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
	const cancelled = cancelledCallbackIds(ordered);
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

	for (const scheduled of ordered) {
		if (scheduled.kind !== "time.callback.scheduled") continue;
		const callbackId = callbackIdOf(scheduled);
		const dueTime = typeof scheduled.payload.dueTime === "string" ? scheduled.payload.dueTime : undefined;
		if (!callbackId || !dueTime || Date.parse(dueTime) > now.getTime()) continue;
		queue.push({
			callbackId,
			kind: "scheduled_callback",
			dueTime,
			summary:
				typeof scheduled.payload.summary === "string" ? scheduled.payload.summary : `Callback due: ${callbackId}`,
			targetEventId:
				typeof scheduled.payload.targetEventId === "string" ? scheduled.payload.targetEventId : scheduled.objectId,
			importance: scheduled.importance,
		});
	}

	return dedupeQueue(queue)
		.filter(
			(item) =>
				!completed.has(item.callbackId) && !cancelled.has(item.callbackId) && !existingDue.has(item.callbackId),
		)
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
	const scheduledCallbacks = buildScheduledCallbackDrafts(events, { ...options, now }, sessionId, streamId).map(
		(draft) => store.append(draft),
	);
	const queue = buildAkashaDaemonQueue(store.buildTimeline({ limit: Number.MAX_SAFE_INTEGER }), { ...options, now });
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
	return { tick, scheduledCallbacks, dueCallbacks, queue };
}

export function createCallbackScheduledDraft(options: AkashaCallbackDraftOptions): AkashaEventDraft {
	return {
		kind: "time.callback.scheduled",
		sessionId: options.sessionId,
		streamId: options.streamId,
		eventTime: options.eventTime ?? new Date().toISOString(),
		actor: options.actor ?? "system",
		subjectId: options.subjectId ?? "akasha.daemon",
		objectId: options.targetEventId,
		sourceKey: options.sourceKey ?? `time-callback-scheduled:${options.callbackId}`,
		parentEventIds: options.parentEventIds ?? [],
		payload: {
			callbackId: options.callbackId,
			kind: options.kind,
			dueTime: options.dueTime,
			summary: options.summary,
			targetEventId: options.targetEventId,
		},
		importance: options.importance ?? 0.7,
		ttlPolicy: "long_term",
	};
}

export function markAkashaCallbackCompleted(
	store: AkashaStore,
	callbackId: string,
	options: {
		evidenceEventId?: string;
		eventTime?: string;
		reason?: string;
	} = {},
): AkashaEvent {
	const timeline = store.buildTimeline({ limit: Number.MAX_SAFE_INTEGER });
	const callbackEvents = timeline.filter((event) => callbackIdOf(event) === callbackId);
	const latest = callbackEvents.at(-1);
	const sessionId = latest?.sessionId ?? timeline.at(-1)?.sessionId ?? "unknown";
	const streamId = latest?.streamId ?? timeline.at(-1)?.streamId ?? `session:${sessionId}`;
	return store.append({
		kind: "time.callback.completed",
		sessionId,
		streamId,
		eventTime: options.eventTime ?? new Date().toISOString(),
		actor: "system",
		subjectId: "akasha.daemon",
		objectId: latest?.objectId,
		sourceKey: `time-callback-completed:${callbackId}:${options.evidenceEventId ?? "manual"}`,
		parentEventIds: [...new Set([latest?.eventId, options.evidenceEventId].filter((id): id is string => !!id))],
		payload: {
			callbackId,
			evidenceEventId: options.evidenceEventId,
			reason: options.reason ?? "completed",
		},
		importance: 0.7,
		ttlPolicy: "long_term",
	});
}

export function markAkashaCallbackCancelled(
	store: AkashaStore,
	callbackId: string,
	options: {
		eventTime?: string;
		reason?: string;
	} = {},
): AkashaEvent {
	const timeline = store.buildTimeline({ limit: Number.MAX_SAFE_INTEGER });
	const callbackEvents = timeline.filter((event) => callbackIdOf(event) === callbackId);
	const latest = callbackEvents.at(-1);
	const sessionId = latest?.sessionId ?? timeline.at(-1)?.sessionId ?? "unknown";
	const streamId = latest?.streamId ?? timeline.at(-1)?.streamId ?? `session:${sessionId}`;
	return store.append({
		kind: "time.callback.cancelled",
		sessionId,
		streamId,
		eventTime: options.eventTime ?? new Date().toISOString(),
		actor: "system",
		subjectId: "akasha.daemon",
		objectId: latest?.objectId,
		sourceKey: `time-callback-cancelled:${callbackId}:${options.reason ?? "cancelled"}`,
		parentEventIds: latest ? [latest.eventId] : [],
		payload: {
			callbackId,
			reason: options.reason ?? "cancelled",
		},
		importance: 0.6,
		ttlPolicy: "long_term",
	});
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

function buildScheduledCallbackDrafts(
	events: AkashaEvent[],
	options: AkashaDaemonQueueOptions & { now: Date },
	sessionId: string,
	streamId: string,
): AkashaEventDraft[] {
	const now = options.now;
	const ordered = orderAkashaEvents(events);
	const ledger = buildKarmaLedger(ordered, now);
	const completed = completedCallbackIds(ordered);
	const cancelled = cancelledCallbackIds(ordered);
	const scheduled = scheduledCallbackIds(ordered);
	const due = dueCallbackIds(ordered);
	const drafts: AkashaEventDraft[] = [];
	for (const promise of ledger.promises) {
		if (promise.state !== "open" || !promise.dueTime || Date.parse(promise.dueTime) <= now.getTime()) continue;
		const callbackId = `promise:${promise.promiseId}:${promise.dueTime}`;
		if (completed.has(callbackId) || cancelled.has(callbackId) || scheduled.has(callbackId) || due.has(callbackId))
			continue;
		drafts.push(
			createCallbackScheduledDraft({
				sessionId,
				streamId,
				callbackId,
				kind: "promise_due",
				dueTime: promise.dueTime,
				summary: `Promise due: ${promise.summary}`,
				targetEventId: promise.lastEventId,
				parentEventIds: [promise.lastEventId],
				sourceKey: `time-callback-scheduled:${callbackId}`,
				importance: 0.75,
			}),
		);
	}
	for (const prediction of ledger.predictions) {
		if (
			prediction.state !== "pending" ||
			!prediction.checkAfter ||
			Date.parse(prediction.checkAfter) <= now.getTime()
		) {
			continue;
		}
		const callbackId = `prediction:${prediction.predictionId}:${prediction.checkAfter}`;
		if (completed.has(callbackId) || cancelled.has(callbackId) || scheduled.has(callbackId) || due.has(callbackId))
			continue;
		drafts.push(
			createCallbackScheduledDraft({
				sessionId,
				streamId,
				callbackId,
				kind: "prediction_due",
				dueTime: prediction.checkAfter,
				summary: `Prediction due: ${prediction.claim}`,
				targetEventId: prediction.lastEventId,
				parentEventIds: [prediction.lastEventId],
				sourceKey: `time-callback-scheduled:${callbackId}`,
				importance: 0.75,
			}),
		);
	}
	return drafts;
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

function scheduledCallbackIds(events: AkashaEvent[]): Set<string> {
	return new Set(
		events.flatMap((event) =>
			event.kind === "time.callback.scheduled" && typeof event.payload.callbackId === "string"
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

function cancelledCallbackIds(events: AkashaEvent[]): Set<string> {
	return new Set(
		events.flatMap((event) =>
			event.kind === "time.callback.cancelled" && typeof event.payload.callbackId === "string"
				? [event.payload.callbackId]
				: [],
		),
	);
}

function callbackIdOf(event: AkashaEvent): string | undefined {
	return typeof event.payload.callbackId === "string" ? event.payload.callbackId : undefined;
}

function dedupeQueue(queue: AkashaDaemonQueueItem[]): AkashaDaemonQueueItem[] {
	const byCallbackId = new Map<string, AkashaDaemonQueueItem>();
	for (const item of queue) {
		const existing = byCallbackId.get(item.callbackId);
		if (!existing || item.importance > existing.importance) {
			byCallbackId.set(item.callbackId, item);
		}
	}
	return [...byCallbackId.values()];
}
