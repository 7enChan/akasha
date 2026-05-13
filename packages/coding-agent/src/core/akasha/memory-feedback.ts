import type { AkashaMemoryTrace } from "./memory-trace.js";
import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaMemoryTraceFeedback {
	traceId: string;
	eventId?: string;
	recallCount: number;
	lastRecalledAt?: string;
	reinforcement: number;
	decay: number;
}

export interface AkashaMemoryFeedbackProjection {
	byTraceId: Map<string, AkashaMemoryTraceFeedback>;
	byEventId: Map<string, AkashaMemoryTraceFeedback>;
}

const RECALL_BONUS = 0.01;
const MAX_RECALL_BONUS = 0.08;

export function buildAkashaMemoryFeedback(events: AkashaEvent[]): AkashaMemoryFeedbackProjection {
	const byTraceId = new Map<string, AkashaMemoryTraceFeedback>();
	const byEventId = new Map<string, AkashaMemoryTraceFeedback>();
	const recalls = new Map<string, AkashaEvent>();

	for (const event of orderAkashaEvents(events)) {
		if (event.kind === "memory.recalled") {
			recalls.set(event.eventId, event);
			const recalledTraceIds = stringArrayPayload(event, "recalledTraceIds");
			const recalledEventIds = stringArrayPayload(event, "recalledEventIds");
			for (const traceId of recalledTraceIds) {
				const feedback = getTraceFeedback(byTraceId, traceId);
				feedback.recallCount += 1;
				feedback.lastRecalledAt = event.eventTime;
			}
			for (const eventId of recalledEventIds) {
				const feedback = getEventFeedback(byEventId, eventId);
				feedback.recallCount += 1;
				feedback.lastRecalledAt = event.eventTime;
			}
			continue;
		}

		if (event.kind === "memory.reinforced" || event.kind === "memory.weakened") {
			const recallEventId = stringPayload(event, "recallEventId");
			const recalled = recallEventId ? recalls.get(recallEventId) : undefined;
			const delta = event.kind === "memory.reinforced" ? 0.14 : -0.16;
			for (const traceId of stringArrayPayload(recalled, "recalledTraceIds")) {
				getTraceFeedback(byTraceId, traceId).reinforcement += delta;
			}
			for (const eventId of stringArrayPayload(recalled, "recalledEventIds")) {
				getEventFeedback(byEventId, eventId).reinforcement += delta;
			}
			continue;
		}

		if (event.kind === "memory.decayed") {
			const traceId = stringPayload(event, "traceId");
			const targetEventId = stringPayload(event, "targetEventId");
			if (traceId) getTraceFeedback(byTraceId, traceId).decay += 0.16;
			if (targetEventId) getEventFeedback(byEventId, targetEventId).decay += 0.16;
			continue;
		}

		if (event.kind === "memory.reconsolidated") {
			const oldMemoryEventId = stringPayload(event, "oldMemoryEventId");
			const newMemoryEventId = stringPayload(event, "newMemoryEventId");
			if (oldMemoryEventId) getEventFeedback(byEventId, oldMemoryEventId).reinforcement -= 0.2;
			if (newMemoryEventId) getEventFeedback(byEventId, newMemoryEventId).reinforcement += 0.12;
		}
	}

	return { byTraceId, byEventId };
}

export function applyAkashaMemoryFeedbackToTraces(
	traces: AkashaMemoryTrace[],
	feedback: AkashaMemoryFeedbackProjection,
): AkashaMemoryTrace[] {
	return traces.map((trace) => {
		const traceFeedback = feedback.byTraceId.get(trace.traceId);
		const eventFeedback = feedback.byEventId.get(trace.eventId);
		const recallCount =
			trace.recallCount + Math.max(traceFeedback?.recallCount ?? 0, eventFeedback?.recallCount ?? 0);
		const reinforcement = combineFeedbackDelta(traceFeedback?.reinforcement ?? 0, eventFeedback?.reinforcement ?? 0);
		const decay = Math.max(traceFeedback?.decay ?? 0, eventFeedback?.decay ?? 0);
		const recallBonus = Math.min(MAX_RECALL_BONUS, recallCount * RECALL_BONUS);
		const lastRecalledAt = latestIso(
			trace.lastRecalledAt,
			traceFeedback?.lastRecalledAt,
			eventFeedback?.lastRecalledAt,
		);
		return {
			...trace,
			weight: clamp01(trace.weight + reinforcement - decay + recallBonus),
			confidence: clamp01(trace.confidence + Math.max(-0.08, Math.min(0.08, reinforcement / 2 - decay / 3))),
			recallCount,
			lastRecalledAt,
		};
	});
}

function getTraceFeedback(map: Map<string, AkashaMemoryTraceFeedback>, traceId: string): AkashaMemoryTraceFeedback {
	const existing = map.get(traceId);
	if (existing) return existing;
	const created: AkashaMemoryTraceFeedback = {
		traceId,
		recallCount: 0,
		reinforcement: 0,
		decay: 0,
	};
	map.set(traceId, created);
	return created;
}

function getEventFeedback(map: Map<string, AkashaMemoryTraceFeedback>, eventId: string): AkashaMemoryTraceFeedback {
	const existing = map.get(eventId);
	if (existing) return existing;
	const created: AkashaMemoryTraceFeedback = {
		traceId: `event:${eventId}`,
		eventId,
		recallCount: 0,
		reinforcement: 0,
		decay: 0,
	};
	map.set(eventId, created);
	return created;
}

function stringPayload(event: AkashaEvent | undefined, key: string): string | undefined {
	const value = event?.payload[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayPayload(event: AkashaEvent | undefined, key: string): string[] {
	const value = event?.payload[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function latestIso(...values: Array<string | undefined>): string | undefined {
	return values
		.filter((value): value is string => typeof value === "string")
		.sort()
		.at(-1);
}

function combineFeedbackDelta(a: number, b: number): number {
	if (a === 0) return b;
	if (b === 0) return a;
	if (Math.sign(a) === Math.sign(b)) return Math.sign(a) * Math.max(Math.abs(a), Math.abs(b));
	return a + b;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}
