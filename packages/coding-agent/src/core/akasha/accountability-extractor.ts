import type { AkashaEvent, AkashaEventDraft } from "./types.js";

export interface AkashaAccountabilityExtractionOptions {
	now?: Date;
	maxItems?: number;
}

export function deriveAccountabilityEventsFromAssistant(
	assistantEvent: AkashaEvent,
	options: AkashaAccountabilityExtractionOptions = {},
): AkashaEventDraft[] {
	if (assistantEvent.kind !== "message.agent.completed") return [];
	const text = typeof assistantEvent.payload.text === "string" ? assistantEvent.payload.text : "";
	if (!text.trim()) return [];
	const now = options.now ?? new Date(assistantEvent.eventTime);
	const maxItems = Math.max(1, options.maxItems ?? 4);
	const promises = extractPromises(text, now).slice(0, maxItems);
	const predictions = extractPredictions(text, now).slice(0, Math.max(0, maxItems - promises.length));

	return [
		...promises.map((promise, index) => ({
			kind: "promise.created" as const,
			sessionId: assistantEvent.sessionId,
			streamId: assistantEvent.streamId,
			eventTime: assistantEvent.eventTime,
			actor: "agent" as const,
			subjectId: "assistant",
			objectId: promise.summary,
			sourceKey: `accountability:${assistantEvent.eventId}:promise:${index}`,
			parentEventIds: [assistantEvent.eventId],
			correlationId: assistantEvent.correlationId,
			payload: {
				promiseId: `promise:${assistantEvent.eventId}:${index}`,
				summary: promise.summary,
				dueTime: promise.dueTime,
				extractedFrom: assistantEvent.eventId,
			},
			importance: 0.8,
			ttlPolicy: "long_term" as const,
		})),
		...predictions.map((prediction, index) => ({
			kind: "prediction.made" as const,
			sessionId: assistantEvent.sessionId,
			streamId: assistantEvent.streamId,
			eventTime: assistantEvent.eventTime,
			actor: "agent" as const,
			subjectId: "assistant",
			objectId: prediction.claim,
			sourceKey: `accountability:${assistantEvent.eventId}:prediction:${index}`,
			parentEventIds: [assistantEvent.eventId],
			correlationId: assistantEvent.correlationId,
			payload: {
				predictionId: `prediction:${assistantEvent.eventId}:${index}`,
				claim: prediction.claim,
				checkAfter: prediction.checkAfter,
				confidence: prediction.confidence,
				extractedFrom: assistantEvent.eventId,
			},
			importance: 0.75,
			ttlPolicy: "long_term" as const,
		})),
	];
}

function extractPromises(text: string, now: Date): Array<{ summary: string; dueTime?: string }> {
	const results: Array<{ summary: string; dueTime?: string }> = [];
	for (const match of text.matchAll(/\b(?:I will|I'll|I’ll|I am going to)\s+([^.!?\n]+)/gi)) {
		const summary = clean(match[0]);
		if (summary) results.push({ summary, dueTime: parseDueTime(summary, now) });
	}
	for (const match of text.matchAll(/(?:我会|我将)([^。！？\n]+)/g)) {
		const summary = clean(`我会${match[1] ?? ""}`);
		if (summary) results.push({ summary, dueTime: parseDueTime(summary, now) });
	}
	return dedupe(results, (item) => item.summary);
}

function extractPredictions(text: string, now: Date): Array<{ claim: string; checkAfter: string; confidence: number }> {
	const results: Array<{ claim: string; checkAfter: string; confidence: number }> = [];
	for (const sentence of splitSentences(text)) {
		const lower = sentence.toLowerCase();
		if (
			lower.includes("should ") ||
			lower.includes("likely ") ||
			lower.includes("probably ") ||
			lower.includes("i expect") ||
			sentence.includes("应该") ||
			sentence.includes("可能") ||
			sentence.includes("预计")
		) {
			results.push({
				claim: clean(sentence),
				checkAfter: addDays(now, 1).toISOString(),
				confidence: lower.includes("probably") || sentence.includes("可能") ? 0.6 : 0.7,
			});
		}
	}
	return dedupe(results, (item) => item.claim);
}

function parseDueTime(text: string, now: Date): string | undefined {
	const isoDate = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
	if (isoDate?.[1]) return new Date(`${isoDate[1]}T09:00:00.000Z`).toISOString();
	const lower = text.toLowerCase();
	if (lower.includes("tomorrow") || text.includes("明天")) return addDays(now, 1).toISOString();
	if (lower.includes("later") || text.includes("稍后") || text.includes("之后")) return addDays(now, 1).toISOString();
	if (lower.includes("next week") || text.includes("下周")) return addDays(now, 7).toISOString();
	return undefined;
}

function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?。！？])\s+/u)
		.map(clean)
		.filter(Boolean);
}

function clean(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function addDays(date: Date, days: number): Date {
	return new Date(date.getTime() + days * 86_400_000);
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const item of items) {
		const value = key(item).toLowerCase();
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(item);
	}
	return result;
}
