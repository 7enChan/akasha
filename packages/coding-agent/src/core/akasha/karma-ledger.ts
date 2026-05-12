import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent } from "./types.js";

export type AkashaPromiseState = "open" | "overdue" | "resolved";
export type AkashaPredictionState = "pending" | "due" | "checked" | "corrected";

export interface AkashaPromiseRecord {
	promiseId: string;
	state: AkashaPromiseState;
	summary: string;
	createdEventId: string;
	lastEventId: string;
	createdTime: string;
	lastEventTime: string;
	dueTime?: string;
	resolvedEventId?: string;
	resolution?: string;
	parentEventIds: string[];
}

export interface AkashaPredictionRecord {
	predictionId: string;
	state: AkashaPredictionState;
	claim: string;
	createdEventId: string;
	lastEventId: string;
	createdTime: string;
	lastEventTime: string;
	checkAfter?: string;
	confidence?: number;
	actual?: string;
	correct?: boolean;
	correction?: string;
	parentEventIds: string[];
}

export interface AkashaKarmaLedger {
	promises: AkashaPromiseRecord[];
	predictions: AkashaPredictionRecord[];
	openPromiseCount: number;
	overduePromiseCount: number;
	duePredictionCount: number;
	correctedPredictionCount: number;
}

export function buildKarmaLedger(events: AkashaEvent[], now: Date = new Date()): AkashaKarmaLedger {
	const promises = new Map<string, AkashaPromiseRecord>();
	const predictions = new Map<string, AkashaPredictionRecord>();

	for (const event of orderAkashaEvents(events)) {
		if (event.kind === "promise.created") {
			const promiseId = payloadString(event, "promiseId") ?? event.eventId;
			promises.set(promiseId, {
				promiseId,
				state: "open",
				summary: payloadString(event, "summary") ?? payloadString(event, "text") ?? "Promise",
				createdEventId: event.eventId,
				lastEventId: event.eventId,
				createdTime: event.eventTime,
				lastEventTime: event.eventTime,
				dueTime: payloadString(event, "dueTime"),
				parentEventIds: event.parentEventIds,
			});
			continue;
		}

		if (event.kind === "promise.updated" || event.kind === "promise.resolved") {
			const promiseId = payloadString(event, "promiseId") ?? event.parentEventIds[0];
			if (!promiseId) continue;
			const existing = promises.get(promiseId);
			if (!existing) continue;
			promises.set(promiseId, {
				...existing,
				state: event.kind === "promise.resolved" ? "resolved" : existing.state,
				summary: payloadString(event, "summary") ?? existing.summary,
				dueTime: payloadString(event, "dueTime") ?? existing.dueTime,
				lastEventId: event.eventId,
				lastEventTime: event.eventTime,
				resolvedEventId: event.kind === "promise.resolved" ? event.eventId : existing.resolvedEventId,
				resolution: payloadString(event, "resolution") ?? existing.resolution,
			});
			continue;
		}

		if (event.kind === "prediction.made") {
			const predictionId = payloadString(event, "predictionId") ?? event.eventId;
			predictions.set(predictionId, {
				predictionId,
				state: "pending",
				claim: payloadString(event, "claim") ?? payloadString(event, "summary") ?? "Prediction",
				createdEventId: event.eventId,
				lastEventId: event.eventId,
				createdTime: event.eventTime,
				lastEventTime: event.eventTime,
				checkAfter: payloadString(event, "checkAfter") ?? payloadString(event, "dueTime"),
				confidence: payloadNumber(event, "confidence"),
				parentEventIds: event.parentEventIds,
			});
			continue;
		}

		if (event.kind === "prediction.checked" || event.kind === "prediction.corrected") {
			const predictionId = payloadString(event, "predictionId") ?? event.parentEventIds[0];
			if (!predictionId) continue;
			const existing = predictions.get(predictionId);
			if (!existing) continue;
			predictions.set(predictionId, {
				...existing,
				state: event.kind === "prediction.corrected" ? "corrected" : "checked",
				lastEventId: event.eventId,
				lastEventTime: event.eventTime,
				actual: payloadString(event, "actual") ?? existing.actual,
				correct: payloadBoolean(event, "correct") ?? existing.correct,
				correction: payloadString(event, "correction") ?? existing.correction,
			});
		}
	}

	for (const promise of promises.values()) {
		if (promise.state === "open" && promise.dueTime && new Date(promise.dueTime).getTime() < now.getTime()) {
			promise.state = "overdue";
		}
	}

	for (const prediction of predictions.values()) {
		if (
			prediction.state === "pending" &&
			prediction.checkAfter &&
			new Date(prediction.checkAfter).getTime() < now.getTime()
		) {
			prediction.state = "due";
		}
	}

	const promiseList = [...promises.values()].sort((a, b) => b.lastEventTime.localeCompare(a.lastEventTime));
	const predictionList = [...predictions.values()].sort((a, b) => b.lastEventTime.localeCompare(a.lastEventTime));
	return {
		promises: promiseList,
		predictions: predictionList,
		openPromiseCount: promiseList.filter((promise) => promise.state === "open").length,
		overduePromiseCount: promiseList.filter((promise) => promise.state === "overdue").length,
		duePredictionCount: predictionList.filter((prediction) => prediction.state === "due").length,
		correctedPredictionCount: predictionList.filter((prediction) => prediction.state === "corrected").length,
	};
}

function payloadString(event: AkashaEvent, key: string): string | undefined {
	return typeof event.payload[key] === "string" ? event.payload[key] : undefined;
}

function payloadNumber(event: AkashaEvent, key: string): number | undefined {
	return typeof event.payload[key] === "number" ? event.payload[key] : undefined;
}

function payloadBoolean(event: AkashaEvent, key: string): boolean | undefined {
	return typeof event.payload[key] === "boolean" ? event.payload[key] : undefined;
}
