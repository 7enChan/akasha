import { JsonlAkashaStore } from "./jsonl-store.js";
import { buildKarmaLedger } from "./karma-ledger.js";
import { buildMemoryGovernance } from "./memory-governance.js";
import { orderAkashaEvents } from "./ordering.js";
import { applyAkashaRedactions } from "./redaction.js";
import { buildAkashaSessionIndex } from "./session-index.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaUserTimelineOptions {
	agentDir: string;
	eventLogDir?: string;
	limit?: number;
}

export interface AkashaUserFact {
	eventId: string;
	text: string;
	eventTime: string;
	confidence: number;
	pinned?: boolean;
}

export interface AkashaUserTimeline {
	events: AkashaEvent[];
	preferences: AkashaUserFact[];
	longTermGoals: AkashaUserFact[];
	collaborationHints: AkashaUserFact[];
	openCommitments: AkashaUserFact[];
	duePredictions: AkashaUserFact[];
	corrections: AkashaUserFact[];
	pinnedEventIds: string[];
	suppressedEventIds: string[];
	lastEventId?: string;
	lastEventTime?: string;
}

export function buildAkashaUserTimeline(options: AkashaUserTimelineOptions): AkashaUserTimeline {
	const events = orderAkashaEvents(
		buildAkashaSessionIndex({
			agentDir: options.agentDir,
			eventLogDir: options.eventLogDir,
		}).flatMap((entry) => new JsonlAkashaStore(entry.eventLogPath).buildTimeline({ limit: Number.MAX_SAFE_INTEGER })),
	);
	const limited = typeof options.limit === "number" && options.limit > 0 ? events.slice(-options.limit) : events;
	return buildAkashaUserTimelineFromEvents(limited);
}

export function buildAkashaUserTimelineFromEvents(events: AkashaEvent[]): AkashaUserTimeline {
	const redacted = applyAkashaRedactions(orderAkashaEvents(events));
	const governance = buildMemoryGovernance(redacted);
	const ordered = redacted.filter((event) => !governance.suppressedEventIds.has(event.eventId));
	const preferences: AkashaUserFact[] = [];
	const longTermGoals: AkashaUserFact[] = [];
	const collaborationHints: AkashaUserFact[] = [];
	const corrections: AkashaUserFact[] = [];

	for (const event of ordered) {
		if (event.kind === "preference.inferred" || event.kind === "memory.crystal.created") {
			const text = crystalText(event);
			if (text && looksLikePreference(text)) {
				preferences.push(fact(event, text, numericPayload(event, "confidence") ?? 0.7, governance.pinnedEventIds));
			}
		}

		if (event.kind === "message.user.submitted") {
			const text = eventText(event);
			if (looksLikePreference(text)) preferences.push(fact(event, text, 0.6, governance.pinnedEventIds));
			if (looksLikeLongTermGoal(text)) longTermGoals.push(fact(event, text, 0.6, governance.pinnedEventIds));
			if (looksLikeCollaborationHint(text))
				collaborationHints.push(fact(event, text, 0.75, governance.pinnedEventIds));
		}

		if (event.kind === "prediction.corrected") {
			const claim = stringPayload(event, "claim") ?? eventText(event);
			const correction = stringPayload(event, "correction") ?? stringPayload(event, "actual") ?? "";
			corrections.push(
				fact(event, correction ? `${claim} -> ${correction}` : claim, 0.8, governance.pinnedEventIds),
			);
		}
	}

	const karma = buildKarmaLedger(ordered);
	const lastEvent = ordered.at(-1);
	return {
		events: ordered,
		preferences: newestUnique(preferences),
		longTermGoals: newestUnique(longTermGoals),
		collaborationHints: newestUnique(collaborationHints),
		openCommitments: karma.promises
			.filter((promise) => promise.state !== "resolved")
			.map((promise) => ({
				eventId: promise.lastEventId,
				text: promise.summary,
				eventTime: promise.lastEventTime,
				confidence: promise.state === "overdue" ? 0.9 : 0.75,
				pinned: governance.pinnedEventIds.has(promise.lastEventId),
			})),
		duePredictions: karma.predictions
			.filter((prediction) => prediction.state === "due")
			.map((prediction) => ({
				eventId: prediction.lastEventId,
				text: prediction.claim,
				eventTime: prediction.lastEventTime,
				confidence: prediction.confidence ?? 0.7,
				pinned: governance.pinnedEventIds.has(prediction.lastEventId),
			})),
		corrections: newestUnique(corrections),
		pinnedEventIds: [...governance.pinnedEventIds],
		suppressedEventIds: [...governance.suppressedEventIds],
		lastEventId: lastEvent?.eventId,
		lastEventTime: lastEvent?.eventTime,
	};
}

export function summarizeUserTimeline(timeline: AkashaUserTimeline, maxItems = 6): string {
	const lines = [`User timeline: ${timeline.events.length} events`];
	if (timeline.lastEventTime) lines.push(`last event: ${timeline.lastEventTime}`);
	appendFacts(lines, "Preferences", timeline.preferences, maxItems);
	appendFacts(lines, "Long-term goals", timeline.longTermGoals, maxItems);
	appendFacts(lines, "Collaboration hints", timeline.collaborationHints, maxItems);
	appendFacts(lines, "Open commitments", timeline.openCommitments, maxItems);
	appendFacts(lines, "Due predictions", timeline.duePredictions, maxItems);
	appendFacts(lines, "Corrections", timeline.corrections, maxItems);
	return lines.join("\n");
}

function appendFacts(lines: string[], label: string, facts: AkashaUserFact[], maxItems: number): void {
	lines.push("", `${label}:`);
	if (facts.length === 0) {
		lines.push("- (none)");
		return;
	}
	for (const fact of facts.slice(0, maxItems)) {
		lines.push(`- ${fact.pinned ? "[pinned] " : ""}${fact.text}`);
	}
}

function fact(event: AkashaEvent, text: string, confidence: number, pinnedEventIds: Set<string>): AkashaUserFact {
	return {
		eventId: event.eventId,
		text: truncate(text),
		eventTime: event.eventTime,
		confidence,
		pinned: pinnedEventIds.has(event.eventId),
	};
}

function newestUnique(facts: AkashaUserFact[]): AkashaUserFact[] {
	const seen = new Set<string>();
	const result: AkashaUserFact[] = [];
	for (const fact of [...facts].reverse()) {
		const key = fact.text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(fact);
	}
	return result;
}

function crystalText(event: AkashaEvent): string {
	const payload = event.payload;
	if (typeof payload.statement === "string") return payload.statement;
	if (typeof payload.summary === "string") return payload.summary;
	if (typeof payload.text === "string") return payload.text;
	return "";
}

function eventText(event: AkashaEvent): string {
	const payload = event.payload;
	if (typeof payload.text === "string") return payload.text;
	if (typeof payload.summary === "string") return payload.summary;
	if (typeof payload.claim === "string") return payload.claim;
	return "";
}

function stringPayload(event: AkashaEvent, key: string): string | undefined {
	return typeof event.payload[key] === "string" ? event.payload[key] : undefined;
}

function numericPayload(event: AkashaEvent, key: string): number | undefined {
	return typeof event.payload[key] === "number" ? event.payload[key] : undefined;
}

function looksLikePreference(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		lower.includes("prefer") ||
		lower.includes("i like") ||
		lower.includes("i want") ||
		text.includes("我喜欢") ||
		text.includes("我希望") ||
		text.includes("偏好")
	);
}

function looksLikeLongTermGoal(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		lower.includes("long-term") ||
		lower.includes("goal") ||
		lower.includes("roadmap") ||
		text.includes("长期") ||
		text.includes("目标") ||
		text.includes("路线图")
	);
}

function looksLikeCollaborationHint(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		lower.includes("do not interrupt") ||
		lower.includes("don't interrupt") ||
		lower.includes("autonomously") ||
		lower.includes("write a plan") ||
		lower.includes("without asking") ||
		text.includes("不要中断") ||
		text.includes("自主决策") ||
		text.includes("先写") ||
		text.includes("不要问")
	);
}

function truncate(text: string, maxLength = 220): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
