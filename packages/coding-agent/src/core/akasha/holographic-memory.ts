import { createHash } from "node:crypto";
import type { AkashaMemoryCue } from "./memory-cue.js";
import { type AkashaMemoryTraceScore, rankAkashaMemoryTraces } from "./memory-resonance.js";
import type { AkashaMemoryTrace } from "./memory-trace.js";
import { type AkashaProcedure, buildAkashaProceduralMemories, formatAkashaProcedures } from "./procedural-memory.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaMemoryEpisode {
	episodeId: string;
	title: string;
	eventIds: string[];
	traceIds: string[];
	reason: string;
}

export interface AkashaMemoryPattern {
	patternId: string;
	summary: string;
	eventIds: string[];
	traceIds: string[];
	confidence: number;
}

export interface AkashaMemoryLesson {
	lessonId: string;
	text: string;
	eventIds: string[];
	traceIds: string[];
	confidence: number;
}

export interface AkashaMemoryWarning {
	warningId: string;
	text: string;
	eventIds: string[];
	traceIds: string[];
	severity: "info" | "warning" | "critical";
}

export interface AkashaMemorySuggestedAction {
	actionId: string;
	text: string;
	sourceEventIds: string[];
	confidence: number;
}

export interface AkashaReconstructedMemoryField {
	fieldId: string;
	cue: AkashaMemoryCue;
	recalledEventIds: string[];
	recalledCrystalIds: string[];
	recalledTraceIds: string[];
	episodes: AkashaMemoryEpisode[];
	patterns: AkashaMemoryPattern[];
	lessons: AkashaMemoryLesson[];
	procedures: AkashaProcedure[];
	warnings: AkashaMemoryWarning[];
	suggestedActions: AkashaMemorySuggestedAction[];
	tokenEstimate: number;
	sourceEventIds: string[];
	topReasons: string[];
}

export interface AkashaHolographicMemoryOptions {
	maxTraces?: number;
	maxEpisodes?: number;
	maxLessons?: number;
	maxProcedures?: number;
	maxWarnings?: number;
	now?: Date;
}

export function reconstructAkashaMemoryField(input: {
	events: AkashaEvent[];
	traces: AkashaMemoryTrace[];
	cue: AkashaMemoryCue;
	options?: AkashaHolographicMemoryOptions;
}): AkashaReconstructedMemoryField {
	const options = input.options ?? {};
	const ranked = rankAkashaMemoryTraces(input.traces, input.cue, {
		maxResults: options.maxTraces ?? 24,
		now: options.now,
	});
	const selectedTraces = ranked.map((score) => score.trace);
	const recalledEventIds = uniqueStrings(selectedTraces.map((trace) => trace.eventId));
	const recalledTraceIds = uniqueStrings(selectedTraces.map((trace) => trace.traceId));
	const sourceEventIds = uniqueStrings([
		...input.cue.sourceEventIds,
		...selectedTraces.flatMap((trace) => trace.sourceEventIds),
	]);
	const eventsById = new Map(input.events.map((event) => [event.eventId, event]));
	const episodes = buildEpisodes(ranked, eventsById).slice(0, options.maxEpisodes ?? 3);
	const lessons = buildLessons(ranked).slice(0, options.maxLessons ?? 3);
	const procedures = buildAkashaProceduralMemories(input.events, {
		maxProcedures: options.maxProcedures ?? 2,
	}).filter(
		(procedure) =>
			procedure.maturity === "validated" && procedureMatchesField(procedure, input.cue, recalledEventIds),
	);
	const warnings = buildWarnings(ranked).slice(0, options.maxWarnings ?? 3);
	const patterns = buildPatterns(ranked).slice(0, 3);
	const suggestedActions = buildSuggestedActions(procedures, warnings).slice(0, 3);
	const recalledCrystalIds = uniqueStrings(
		recalledEventIds.filter((eventId) => {
			const kind = eventsById.get(eventId)?.kind;
			return kind === "memory.crystal.created" || kind === "memory.crystal.updated";
		}),
	);
	const text = formatAkashaHolographicMemoryContext({
		fieldId: "estimate",
		cue: input.cue,
		recalledEventIds,
		recalledCrystalIds,
		recalledTraceIds,
		episodes,
		patterns,
		lessons,
		procedures,
		warnings,
		suggestedActions,
		tokenEstimate: 0,
		sourceEventIds,
		topReasons: topReasons(ranked),
	});
	const fieldWithoutId = {
		cueId: input.cue.cueId,
		recalledEventIds,
		recalledTraceIds,
		episodes: episodes.map((episode) => episode.episodeId),
		lessons: lessons.map((lesson) => lesson.lessonId),
		procedures: procedures.map((procedure) => procedure.procedureId),
		warnings: warnings.map((warning) => warning.warningId),
	};
	return {
		fieldId: `field_${hashJson(fieldWithoutId).slice(0, 24)}`,
		cue: input.cue,
		recalledEventIds,
		recalledCrystalIds,
		recalledTraceIds,
		episodes,
		patterns,
		lessons,
		procedures,
		warnings,
		suggestedActions,
		tokenEstimate: estimateTokens(text),
		sourceEventIds,
		topReasons: topReasons(ranked),
	};
}

export function formatAkashaHolographicMemoryContext(field: AkashaReconstructedMemoryField): string {
	const lines = ["<akasha_holographic_memory>"];
	if (field.episodes.length > 0) {
		lines.push("<episodes>");
		for (const episode of field.episodes) lines.push(`- ${episode.title}: ${episode.reason}`);
		lines.push("</episodes>");
	}
	if (field.lessons.length > 0) {
		lines.push("<applicable_lessons>");
		for (const lesson of field.lessons) lines.push(`- ${lesson.text}`);
		lines.push("</applicable_lessons>");
	}
	if (field.procedures.length > 0) {
		lines.push("<procedural_memory>");
		for (const procedure of formatAkashaProcedures(field.procedures)) lines.push(`- ${procedure}`);
		lines.push("</procedural_memory>");
	}
	if (field.warnings.length > 0) {
		lines.push("<warnings>");
		for (const warning of field.warnings) lines.push(`- [${warning.severity}] ${warning.text}`);
		lines.push("</warnings>");
	}
	if (field.suggestedActions.length > 0) {
		lines.push("<suggested_actions>");
		for (const action of field.suggestedActions) lines.push(`- ${action.text}`);
		lines.push("</suggested_actions>");
	}
	lines.push("</akasha_holographic_memory>");
	return lines.join("\n");
}

function buildEpisodes(ranked: AkashaMemoryTraceScore[], eventsById: Map<string, AkashaEvent>): AkashaMemoryEpisode[] {
	const groups = new Map<string, AkashaMemoryTraceScore[]>();
	for (const score of ranked) {
		if (score.trace.kind === "time" || score.trace.kind === "actor") continue;
		const key = episodeKey(score.trace, eventsById.get(score.trace.eventId));
		const group = groups.get(key) ?? [];
		group.push(score);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.map(([key, scores]) => ({
			episodeId: `episode_${hashText(key).slice(0, 16)}`,
			title: truncate(scores[0]?.trace.key ?? key, 90),
			eventIds: uniqueStrings(scores.map((score) => score.trace.eventId)),
			traceIds: uniqueStrings(scores.map((score) => score.trace.traceId)),
			reason: uniqueStrings(scores.flatMap((score) => score.reasons))
				.slice(0, 4)
				.join(", "),
		}))
		.sort((a, b) => b.traceIds.length - a.traceIds.length);
}

function buildLessons(ranked: AkashaMemoryTraceScore[]): AkashaMemoryLesson[] {
	return ranked
		.filter((score) => score.trace.kind === "failure" || score.trace.kind === "skill")
		.map((score) => ({
			lessonId: `lesson_${hashText(score.trace.traceId).slice(0, 16)}`,
			text: score.trace.text,
			eventIds: [score.trace.eventId],
			traceIds: [score.trace.traceId],
			confidence: Math.min(1, score.trace.confidence + score.score / 10),
		}));
}

function buildWarnings(ranked: AkashaMemoryTraceScore[]): AkashaMemoryWarning[] {
	return ranked
		.filter((score) => score.trace.kind === "failure" || score.trace.kind === "policy" || score.trace.cost)
		.map((score) => ({
			warningId: `warning_${hashText(score.trace.traceId).slice(0, 16)}`,
			text: score.trace.text,
			eventIds: [score.trace.eventId],
			traceIds: [score.trace.traceId],
			severity: score.score >= 2.5 || (score.trace.cost ?? 0) > 0.7 ? "critical" : "warning",
		}));
}

function buildPatterns(ranked: AkashaMemoryTraceScore[]): AkashaMemoryPattern[] {
	return ranked
		.filter(
			(score) => score.trace.kind === "success" || score.trace.kind === "closure" || score.trace.kind === "callback",
		)
		.map((score) => ({
			patternId: `pattern_${hashText(score.trace.traceId).slice(0, 16)}`,
			summary: score.trace.text,
			eventIds: [score.trace.eventId],
			traceIds: [score.trace.traceId],
			confidence: Math.min(1, score.trace.confidence + score.score / 12),
		}));
}

function buildSuggestedActions(
	procedures: AkashaProcedure[],
	warnings: AkashaMemoryWarning[],
): AkashaMemorySuggestedAction[] {
	const actions: AkashaMemorySuggestedAction[] = [];
	for (const procedure of procedures) {
		actions.push({
			actionId: `action_${procedure.procedureId}`,
			text: `Apply procedure: ${procedure.title}`,
			sourceEventIds: procedure.sourceEventIds,
			confidence: procedure.confidence,
		});
	}
	for (const warning of warnings) {
		actions.push({
			actionId: `action_${warning.warningId}`,
			text: `Check warning before acting: ${warning.text}`,
			sourceEventIds: warning.eventIds,
			confidence: warning.severity === "critical" ? 0.85 : 0.65,
		});
	}
	return actions;
}

function procedureMatchesField(procedure: AkashaProcedure, cue: AkashaMemoryCue, recalledEventIds: string[]): boolean {
	if (procedure.sourceEventIds.some((eventId) => recalledEventIds.includes(eventId))) return true;
	const text = `${procedure.title} ${procedure.trigger} ${procedure.steps.join(" ")}`.toLowerCase();
	if (cue.activeFiles.some((file) => text.includes(file.toLowerCase()) || basenameMatches(file, text))) return true;
	if (cue.userText && overlap(cue.userText, text) > 0) return true;
	return cue.recentFailureEventIds.length > 0 && procedure.failureCount > 0;
}

function episodeKey(trace: AkashaMemoryTrace, event?: AkashaEvent): string {
	const callbackId = typeof event?.payload.callbackId === "string" ? event.payload.callbackId : undefined;
	const toolCallId = event?.toolCallId;
	const objectId = event?.objectId;
	return callbackId ?? toolCallId ?? objectId ?? trace.key;
}

function topReasons(ranked: AkashaMemoryTraceScore[]): string[] {
	return uniqueStrings(ranked.flatMap((score) => score.reasons)).slice(0, 8);
}

function overlap(a: string, b: string): number {
	const left = new Set(
		a
			.toLowerCase()
			.split(/[^a-z0-9_\-./\u4e00-\u9fff]+/u)
			.filter((part) => part.length >= 2),
	);
	if (left.size === 0) return 0;
	const right = new Set(
		b
			.toLowerCase()
			.split(/[^a-z0-9_\-./\u4e00-\u9fff]+/u)
			.filter((part) => part.length >= 2),
	);
	let matches = 0;
	for (const token of left) if (right.has(token)) matches++;
	return matches / left.size;
}

function basenameMatches(file: string, text: string): boolean {
	const base = file.split("/").pop();
	if (!base) return false;
	return text.includes(base.toLowerCase());
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.trim()))];
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function hashJson(value: unknown): string {
	return hashText(JSON.stringify(value));
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}
