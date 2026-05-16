import { createHash } from "node:crypto";
import {
	type AkashaClaimRecord,
	type AkashaClaimStatus,
	activeAkashaClaimsAt,
	buildAkashaClaimLedger,
	claimText,
} from "./claim-ledger.js";
import type { AkashaMemoryCue } from "./memory-cue.js";
import { applyAkashaMemoryFeedbackToEdges, buildAkashaMemoryFeedback } from "./memory-feedback.js";
import { activateAkashaMemoryField } from "./memory-field-activation.js";
import type { AkashaMemoryTraceScore } from "./memory-resonance.js";
import type { AkashaMemoryTrace } from "./memory-trace.js";
import { type AkashaMemoryTraceEdge, buildAkashaMemoryTraceEdges } from "./memory-trace-edge.js";
import { type AkashaProcedure, buildAkashaProceduralMemories, formatAkashaProcedures } from "./procedural-memory.js";
import type { AkashaSemanticMemorySeed } from "./semantic-memory-seed.js";
import { buildAkashaTemporalStateLedger } from "./temporal-state-ledger.js";
import type { AkashaTemporalStateClass, AkashaTemporalStateStatus } from "./temporal-validity.js";
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

export interface AkashaMemoryValidityAnnotation {
	stateId: string;
	stateClass: AkashaTemporalStateClass;
	status: AkashaTemporalStateStatus | "historical";
	summary: string;
	eventIds: string[];
	reason: string;
	useAs: "current_fact" | "historical_context" | "requires_currentness_check";
}

export type AkashaMemoryContextDependencyKind = "explicit" | "ambient";

export type AkashaMemoryContextUseAs =
	| "current_context"
	| "historical_context"
	| "requires_revalidation"
	| "possibly_stale_context";

export interface AkashaMemoryContextualValidityAnnotation {
	claimId: string;
	claimKey: string;
	summary: string;
	status: AkashaClaimStatus | "historical";
	dependency: AkashaMemoryContextDependencyKind;
	useAs: AkashaMemoryContextUseAs;
	traceIds: string[];
	eventIds: string[];
	reason: string;
	supersededByClaimId?: string;
}

export interface AkashaReconstructedMemoryField {
	fieldId: string;
	cue: AkashaMemoryCue;
	recalledEventIds: string[];
	recalledCrystalIds: string[];
	recalledTraceIds: string[];
	recalledEdgeIds: string[];
	activationReasons: Record<string, string[]>;
	semanticSeedEventIds: string[];
	semanticSeedReasons: Record<string, string[]>;
	episodes: AkashaMemoryEpisode[];
	patterns: AkashaMemoryPattern[];
	lessons: AkashaMemoryLesson[];
	procedures: AkashaProcedure[];
	warnings: AkashaMemoryWarning[];
	suggestedActions: AkashaMemorySuggestedAction[];
	validityAnnotations: AkashaMemoryValidityAnnotation[];
	contextualValidityAnnotations: AkashaMemoryContextualValidityAnnotation[];
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
	edges?: AkashaMemoryTraceEdge[];
	cue: AkashaMemoryCue;
	semanticSeeds?: AkashaSemanticMemorySeed[];
	options?: AkashaHolographicMemoryOptions;
}): AkashaReconstructedMemoryField {
	const options = input.options ?? {};
	const semanticSeeds = input.semanticSeeds ?? [];
	const feedback = buildAkashaMemoryFeedback(input.events);
	const edges = applyAkashaMemoryFeedbackToEdges(
		input.edges ?? buildAkashaMemoryTraceEdges(input.events, input.traces),
		feedback,
	);
	const activation = activateAkashaMemoryField(input.traces, edges, input.cue, {
		maxResults: options.maxTraces ?? 24,
		now: options.now,
		semanticSeeds,
	});
	const ranked = activation.scores;
	const selectedTraces = ranked.map((score) => score.trace);
	const recalledEventIds = uniqueStrings(selectedTraces.map((trace) => trace.eventId));
	const recalledTraceIds = uniqueStrings(selectedTraces.map((trace) => trace.traceId));
	const recalledEdgeIds = activation.activatedEdgeIds;
	const activationReasons = Object.fromEntries(ranked.map((score) => [score.trace.traceId, score.reasons]));
	const semanticSeedEventIds = uniqueStrings(semanticSeeds.map((seed) => seed.eventId));
	const semanticSeedReasons = buildSemanticSeedReasons(semanticSeeds);
	const sourceEventIds = uniqueStrings([
		...input.cue.sourceEventIds,
		...semanticSeedEventIds,
		...selectedTraces.flatMap((trace) => trace.sourceEventIds),
		...edges.filter((edge) => recalledEdgeIds.includes(edge.edgeId)).flatMap((edge) => edge.sourceEventIds),
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
	const validityAnnotations = buildValidityAnnotations(
		input.events,
		[...recalledEventIds, ...sourceEventIds],
		options.now,
	);
	const contextualValidityAnnotations = buildContextualValidityAnnotations(input.events, selectedTraces, options.now);
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
		recalledEdgeIds,
		activationReasons,
		semanticSeedEventIds,
		semanticSeedReasons,
		episodes,
		patterns,
		lessons,
		procedures,
		warnings,
		suggestedActions,
		validityAnnotations,
		contextualValidityAnnotations,
		tokenEstimate: 0,
		sourceEventIds,
		topReasons: topReasons(ranked),
	});
	const fieldWithoutId = {
		cueId: input.cue.cueId,
		recalledEventIds,
		recalledTraceIds,
		recalledEdgeIds,
		semanticSeedEventIds,
		semanticSeedReasons,
		episodes: episodes.map((episode) => episode.episodeId),
		lessons: lessons.map((lesson) => lesson.lessonId),
		procedures: procedures.map((procedure) => procedure.procedureId),
		warnings: warnings.map((warning) => warning.warningId),
		validityAnnotations: validityAnnotations.map((annotation) => `${annotation.stateId}:${annotation.status}`),
		contextualValidityAnnotations: contextualValidityAnnotations.map(
			(annotation) => `${annotation.claimId}:${annotation.dependency}:${annotation.useAs}`,
		),
		activationReasons,
	};
	return {
		fieldId: `field_${hashJson(fieldWithoutId).slice(0, 24)}`,
		cue: input.cue,
		recalledEventIds,
		recalledCrystalIds,
		recalledTraceIds,
		recalledEdgeIds,
		activationReasons,
		semanticSeedEventIds,
		semanticSeedReasons,
		episodes,
		patterns,
		lessons,
		procedures,
		warnings,
		suggestedActions,
		validityAnnotations,
		contextualValidityAnnotations,
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
	if (field.validityAnnotations.length > 0) {
		lines.push("<validity_annotations>");
		for (const annotation of field.validityAnnotations) {
			lines.push(
				`- ${annotation.stateClass}: ${annotation.summary} => ${annotation.status}; use_as=${annotation.useAs}; ${annotation.reason}`,
			);
		}
		lines.push("</validity_annotations>");
	}
	if (field.contextualValidityAnnotations.length > 0) {
		lines.push("<contextual_validity>");
		for (const annotation of field.contextualValidityAnnotations) {
			lines.push(
				`- ${annotation.summary} => ${annotation.status}; dependency=${annotation.dependency}; use_as=${annotation.useAs}; ${annotation.reason}`,
			);
		}
		lines.push("</contextual_validity>");
	}
	if (field.suggestedActions.length > 0) {
		lines.push("<suggested_actions>");
		for (const action of field.suggestedActions) lines.push(`- ${action.text}`);
		lines.push("</suggested_actions>");
	}
	lines.push("</akasha_holographic_memory>");
	return lines.join("\n");
}

function buildValidityAnnotations(
	events: AkashaEvent[],
	recalledIds: string[],
	now?: Date,
): AkashaMemoryValidityAnnotation[] {
	const recalled = new Set(recalledIds);
	const ledger = buildAkashaTemporalStateLedger(events, { now });
	const annotations: AkashaMemoryValidityAnnotation[] = [];
	for (const state of ledger.states) {
		const relatedIds = [state.observedEventId, state.latestEventId, ...state.sourceEventIds];
		if (!relatedIds.some((eventId) => recalled.has(eventId))) continue;
		const requiresCheck = state.status === "stale" || state.status === "expired";
		annotations.push({
			stateId: state.stateId,
			stateClass: state.stateClass,
			status: state.status,
			summary: state.summary,
			eventIds: uniqueStrings(relatedIds),
			reason: requiresCheck
				? "State was recalled, but its validity window has passed; do not treat it as current without confirmation."
				: state.status === "resolved"
					? "State was recalled as resolved historical context."
					: "State was recalled within its validity window.",
			useAs: requiresCheck
				? "requires_currentness_check"
				: state.status === "current"
					? "current_fact"
					: "historical_context",
		});
	}
	return annotations.slice(0, 6);
}

function buildContextualValidityAnnotations(
	events: AkashaEvent[],
	traces: AkashaMemoryTrace[],
	now?: Date,
): AkashaMemoryContextualValidityAnnotation[] {
	if (traces.length === 0) return [];
	const visibleEvents = now
		? events.filter((event) => {
				const eventTime = Date.parse(event.eventTime);
				return Number.isFinite(eventTime) && eventTime <= now.getTime();
			})
		: events;
	const ledger = buildAkashaClaimLedger(visibleEvents);
	if (ledger.claims.length === 0) return [];

	const eventsById = new Map(visibleEvents.map((event) => [event.eventId, event]));
	const annotations = new Map<string, AkashaMemoryContextualValidityAnnotation>();
	for (const trace of traces) {
		const sourceEvent = eventsById.get(trace.eventId);
		const traceTime = sourceEvent?.eventTime ?? trace.createdAt;
		const activeClaims = activeAkashaClaimsAt(ledger, traceTime);
		for (const claim of activeClaims) {
			const explicit = traceExplicitlyDependsOnClaim(trace, claim);
			const ambient = !explicit && claim.exclusive && claim.status === "superseded";
			if (!explicit && !ambient) continue;

			const dependency: AkashaMemoryContextDependencyKind = explicit ? "explicit" : "ambient";
			const useAs = contextualUseAs(claim, dependency);
			const key = `${claim.claimId}:${dependency}`;
			const eventIds = uniqueStrings([trace.eventId, ...claimRelatedEventIds(claim)]);
			const existing = annotations.get(key);
			if (existing) {
				existing.traceIds = uniqueStrings([...existing.traceIds, trace.traceId]);
				existing.eventIds = uniqueStrings([...existing.eventIds, ...eventIds]);
				continue;
			}
			annotations.set(key, {
				claimId: claim.claimId,
				claimKey: claim.claimKey,
				summary: claim.summary,
				status: claim.status === "superseded" ? "historical" : claim.status,
				dependency,
				useAs,
				traceIds: [trace.traceId],
				eventIds,
				reason: contextualReason(claim, dependency, useAs),
				supersededByClaimId: claim.supersededByClaimId,
			});
		}
	}
	return [...annotations.values()].sort(compareContextualAnnotations).slice(0, 8);
}

function traceExplicitlyDependsOnClaim(trace: AkashaMemoryTrace, claim: AkashaClaimRecord): boolean {
	const traceEventIds = new Set([trace.eventId, ...trace.sourceEventIds]);
	if (claimRelatedEventIds(claim).some((eventId) => traceEventIds.has(eventId))) return true;

	const traceText = `${trace.key} ${trace.text}`.toLowerCase();
	if (traceText.includes(claim.claimId.toLowerCase()) || traceText.includes(claim.claimKey.toLowerCase())) {
		return true;
	}

	const claimValue = claim.value.trim().toLowerCase();
	if (claimValue.length >= 2 && traceText.includes(claimValue)) return true;

	const claimSummary = claimText(claim);
	return sharedTokenCount(claimSummary, traceText) >= 2 || overlap(claimSummary, traceText) >= 0.35;
}

function contextualUseAs(
	claim: AkashaClaimRecord,
	dependency: AkashaMemoryContextDependencyKind,
): AkashaMemoryContextUseAs {
	if (claim.status !== "superseded") return "current_context";
	return dependency === "ambient" ? "possibly_stale_context" : "requires_revalidation";
}

function contextualReason(
	claim: AkashaClaimRecord,
	dependency: AkashaMemoryContextDependencyKind,
	useAs: AkashaMemoryContextUseAs,
): string {
	if (useAs === "current_context") {
		return "Memory is aligned with an active contextual claim.";
	}
	if (dependency === "ambient") {
		return "Memory was formed while this exclusive claim was active; related assumptions may be stale.";
	}
	if (claim.supersededByClaimId) {
		return "Memory explicitly depends on a claim that has been superseded; revalidate before using it as current context.";
	}
	return "Memory explicitly depends on a historical claim; treat it as historical unless revalidated.";
}

function compareContextualAnnotations(
	left: AkashaMemoryContextualValidityAnnotation,
	right: AkashaMemoryContextualValidityAnnotation,
): number {
	return contextualPriority(left) - contextualPriority(right) || right.eventIds.length - left.eventIds.length;
}

function contextualPriority(annotation: AkashaMemoryContextualValidityAnnotation): number {
	if (annotation.useAs === "requires_revalidation") return 0;
	if (annotation.useAs === "possibly_stale_context") return 1;
	if (annotation.useAs === "historical_context") return 2;
	return 3;
}

function claimRelatedEventIds(claim: AkashaClaimRecord): string[] {
	return uniqueStrings([
		claim.observedEventId,
		claim.latestEventId,
		...claim.sourceEventIds,
		...claim.confirmationEventIds,
		claim.supersededEventId ?? "",
		claim.supersededByEventId ?? "",
	]);
}

function sharedTokenCount(a: string, b: string): number {
	const left = tokenizeContext(a);
	const right = tokenizeContext(b);
	let matches = 0;
	for (const token of left) if (right.has(token)) matches++;
	return matches;
}

function tokenizeContext(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_\-./\u4e00-\u9fff]+/u)
			.map((part) => part.trim())
			.filter((part) => part.length >= 2),
	);
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

function buildSemanticSeedReasons(seeds: AkashaSemanticMemorySeed[]): Record<string, string[]> {
	const reasons = new Map<string, string[]>();
	for (const seed of seeds) {
		const values = reasons.get(seed.eventId) ?? [];
		values.push(`${seed.reason}:score=${seed.score.toFixed(2)}`);
		reasons.set(seed.eventId, uniqueStrings(values));
	}
	return Object.fromEntries([...reasons.entries()].sort(([left], [right]) => left.localeCompare(right)));
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
