import { buildAkashaMemoryCue } from "./memory-cue.js";
import { applyAkashaMemoryFeedbackToEdges, buildAkashaMemoryFeedback } from "./memory-feedback.js";
import { activateAkashaMemoryField } from "./memory-field-activation.js";
import { buildAkashaMemoryTraces } from "./memory-trace.js";
import { buildAkashaMemoryTraceEdges } from "./memory-trace-edge.js";
import { rankRecallEvents } from "./recall-policy.js";
import type { AkashaSemanticMemorySeed } from "./semantic-memory-seed.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaRecallEvalCase {
	name: string;
	queryText?: string;
	limit?: number;
	mustInclude?: string[];
	mustExclude?: string[];
}

export interface AkashaRecallEvalFailure {
	caseName: string;
	missing: string[];
	unexpected: string[];
	selected: string[];
}

export interface AkashaRecallEvalResult {
	passed: boolean;
	failures: AkashaRecallEvalFailure[];
}

export interface AkashaRecallEvalOptions {
	rank?: (events: AkashaEvent[], queryText?: string) => AkashaEvent[];
	defaultLimit?: number;
}

export interface AkashaFieldRecallEvalOptions {
	cwd?: string;
	defaultLimit?: number;
	maxTraces?: number;
	now?: Date | string;
	semanticSeeds?: AkashaSemanticMemorySeed[] | ((queryText: string | undefined) => AkashaSemanticMemorySeed[]);
}

export function runAkashaRecallEval(
	events: AkashaEvent[],
	cases: AkashaRecallEvalCase[],
	options: AkashaRecallEvalOptions = {},
): AkashaRecallEvalResult {
	const rank = options.rank ?? rankRecallEvents;
	const defaultLimit = Math.max(1, Math.floor(options.defaultLimit ?? 8));
	const failures: AkashaRecallEvalFailure[] = [];

	for (const testCase of cases) {
		const limit = Math.max(1, Math.floor(testCase.limit ?? defaultLimit));
		const selected = rank(events, testCase.queryText)
			.slice(0, limit)
			.map((event) => event.eventId);
		const selectedIds = new Set(selected);
		const missing = (testCase.mustInclude ?? []).filter((eventId) => !selectedIds.has(eventId));
		const unexpected = (testCase.mustExclude ?? []).filter((eventId) => selectedIds.has(eventId));
		if (missing.length > 0 || unexpected.length > 0) {
			failures.push({
				caseName: testCase.name,
				missing,
				unexpected,
				selected,
			});
		}
	}

	return {
		passed: failures.length === 0,
		failures,
	};
}

export function runAkashaFieldRecallEval(
	events: AkashaEvent[],
	cases: AkashaRecallEvalCase[],
	options: AkashaFieldRecallEvalOptions = {},
): AkashaRecallEvalResult {
	return runAkashaRecallEval(events, cases, {
		defaultLimit: options.defaultLimit,
		rank: (rankEvents, queryText) => rankAkashaFieldRecallEvents(rankEvents, queryText, options),
	});
}

export function rankAkashaFieldRecallEvents(
	events: AkashaEvent[],
	queryText?: string,
	options: AkashaFieldRecallEvalOptions = {},
): AkashaEvent[] {
	const now = normalizeNow(options.now);
	const semanticSeeds =
		typeof options.semanticSeeds === "function" ? options.semanticSeeds(queryText) : options.semanticSeeds;
	const traces = buildAkashaMemoryTraces(events);
	const feedback = buildAkashaMemoryFeedback(events);
	const edges = applyAkashaMemoryFeedbackToEdges(buildAkashaMemoryTraceEdges(events, traces), feedback);
	const cue = buildAkashaMemoryCue({
		latestUserText: queryText,
		cwd: options.cwd ?? process.cwd(),
		sessionEvents: cueEventsForQuery(events, queryText),
		now: now.toISOString(),
	});
	const activation = activateAkashaMemoryField(traces, edges, cue, {
		maxResults: options.maxTraces ?? 32,
		now,
		semanticSeeds,
	});
	const eventsById = new Map(events.map((event) => [event.eventId, event]));
	const ranked: AkashaEvent[] = [];
	const seen = new Set<string>();
	for (const score of activation.scores) {
		if (seen.has(score.trace.eventId)) continue;
		const event = eventsById.get(score.trace.eventId);
		if (!event) continue;
		seen.add(event.eventId);
		ranked.push(event);
	}
	return ranked;
}

export function formatAkashaRecallEvalResult(result: AkashaRecallEvalResult): string {
	if (result.passed) return "Akasha recall eval passed.";
	return [
		"Akasha recall eval failed:",
		...result.failures.map(
			(failure) =>
				`- ${failure.caseName}: missing [${failure.missing.join(", ") || "none"}], unexpected [${
					failure.unexpected.join(", ") || "none"
				}], selected [${failure.selected.join(", ") || "none"}]`,
		),
	].join("\n");
}

function cueEventsForQuery(events: AkashaEvent[], queryText: string | undefined): AkashaEvent[] {
	const tokens = (queryText ?? "")
		.toLowerCase()
		.split(/[^a-z0-9_\-./\u4e00-\u9fff]+/u)
		.filter((token) => token.length >= 2);
	if (tokens.length === 0) return events;
	const matched = events.filter((event) => {
		const text = eventSearchText(event);
		return tokens.some((token) => text.includes(token));
	});
	return matched.length > 0 ? matched : events;
}

function eventSearchText(event: AkashaEvent): string {
	return [
		event.eventId,
		event.kind,
		event.subjectId,
		event.objectId,
		...Object.values(event.payload).flatMap((value) => {
			if (typeof value === "string") return [value];
			if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
			return [];
		}),
	]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join(" ")
		.toLowerCase();
}

function normalizeNow(now: Date | string | undefined): Date {
	if (now instanceof Date) return now;
	if (typeof now === "string") return new Date(now);
	return new Date();
}
