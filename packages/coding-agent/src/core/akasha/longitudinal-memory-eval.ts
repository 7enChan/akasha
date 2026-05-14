import { buildAkashaActionGateContext } from "./action-gate.js";
import { projectAkashaGovernedEvents } from "./governance-projection.js";
import { buildOpenLoopLedger } from "./open-loops.js";
import { rankAkashaFieldRecallEvents } from "./recall-eval.js";
import type { AkashaSemanticMemorySeed } from "./semantic-memory-seed.js";
import { buildAkashaTemporalStateLedger } from "./temporal-state-ledger.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaLongitudinalMemoryEvalCase {
	name: string;
	queryText?: string;
	limit?: number;
	now?: Date | string;
	mustRecall?: string[];
	mustNotRecall?: string[];
	expectOpenLoops?: string[];
	expectCurrentnessChecks?: string[];
	expectActionGateIncludes?: string[];
	expectActionGateExcludes?: string[];
	semanticSeeds?: AkashaSemanticMemorySeed[];
}

export interface AkashaLongitudinalMemoryEvalCaseResult {
	caseName: string;
	selected: string[];
	missingRecall: string[];
	pollutedRecall: string[];
	missingOpenLoops: string[];
	missingCurrentnessChecks: string[];
	staleCurrentFactViolations: string[];
	actionGateMissing: string[];
	actionGateUnexpected: string[];
}

export interface AkashaLongitudinalMemoryEvalMetrics {
	requiredRecall: number;
	recalled: number;
	selected: number;
	pollutedRecall: number;
	expectedOpenLoops: number;
	coveredOpenLoops: number;
	expectedCurrentnessChecks: number;
	coveredCurrentnessChecks: number;
	staleCurrentFactViolations: number;
	actionGateExpectations: number;
	satisfiedActionGateExpectations: number;
	recallHitRate: number;
	pollutionRate: number;
	openLoopCoverage: number;
	currentnessCoverage: number;
	actionGateCoverage: number;
}

export interface AkashaLongitudinalMemoryEvalResult {
	passed: boolean;
	cases: AkashaLongitudinalMemoryEvalCaseResult[];
	metrics: AkashaLongitudinalMemoryEvalMetrics;
}

export interface AkashaLongitudinalMemoryEvalOptions {
	cwd?: string;
	defaultLimit?: number;
	maxTraces?: number;
	now?: Date | string;
	semanticSeeds?: AkashaSemanticMemorySeed[] | ((queryText: string | undefined) => AkashaSemanticMemorySeed[]);
}

export function runAkashaLongitudinalMemoryEval(
	events: AkashaEvent[],
	cases: AkashaLongitudinalMemoryEvalCase[],
	options: AkashaLongitudinalMemoryEvalOptions = {},
): AkashaLongitudinalMemoryEvalResult {
	const governed = projectAkashaGovernedEvents(events).events;
	const caseResults: AkashaLongitudinalMemoryEvalCaseResult[] = [];
	const totals = createEmptyMetrics();

	for (const testCase of cases) {
		const now = normalizeNow(testCase.now ?? options.now);
		const limit = Math.max(1, Math.floor(testCase.limit ?? options.defaultLimit ?? 8));
		const selected = rankAkashaFieldRecallEvents(governed, testCase.queryText, {
			cwd: options.cwd,
			maxTraces: options.maxTraces,
			now,
			semanticSeeds: [
				...resolveSemanticSeeds(options.semanticSeeds, testCase.queryText),
				...(testCase.semanticSeeds ?? []),
			],
		})
			.slice(0, limit)
			.map((event) => event.eventId);
		const selectedIds = new Set(selected);
		const actionGate = buildAkashaActionGateContext({ sessionEvents: governed, now })?.text ?? "";
		const openLoops = buildOpenLoopLedger(governed).filter((loop) => loop.state !== "resolved");
		const openLoopKeys = new Set(
			openLoops.flatMap((loop) => [loop.loopKey, loop.rootEventId, loop.openedEventId].filter(isString)),
		);
		const temporalStates = buildAkashaTemporalStateLedger(governed, { now });
		const currentStateIds = new Set(temporalStates.current.map((state) => state.stateId));
		const currentnessCheckIds = new Set(temporalStates.currentnessChecks.map((state) => state.stateId));

		const missingRecall = (testCase.mustRecall ?? []).filter((eventId) => !selectedIds.has(eventId));
		const pollutedRecall = (testCase.mustNotRecall ?? []).filter((eventId) => selectedIds.has(eventId));
		const missingOpenLoops = (testCase.expectOpenLoops ?? []).filter((loopId) => !openLoopKeys.has(loopId));
		const missingCurrentnessChecks = (testCase.expectCurrentnessChecks ?? []).filter(
			(stateId) => !currentnessCheckIds.has(stateId),
		);
		const selectedStaleStatesMissingCheck = temporalStates.currentnessChecks
			.filter((state) => stateEventWasSelected(state, selectedIds))
			.filter((state) => !actionGate.includes(`Before relying on "${state.summary}"`))
			.map((state) => state.stateId);
		const staleCurrentFactViolations = uniqueStrings([
			...(testCase.expectCurrentnessChecks ?? []).filter((stateId) => currentStateIds.has(stateId)),
			...selectedStaleStatesMissingCheck,
		]);
		const actionGateMissing = (testCase.expectActionGateIncludes ?? []).filter((text) => !actionGate.includes(text));
		const actionGateUnexpected = (testCase.expectActionGateExcludes ?? []).filter((text) =>
			actionGate.includes(text),
		);

		caseResults.push({
			caseName: testCase.name,
			selected,
			missingRecall,
			pollutedRecall,
			missingOpenLoops,
			missingCurrentnessChecks,
			staleCurrentFactViolations,
			actionGateMissing,
			actionGateUnexpected,
		});

		accumulateMetrics(totals, {
			selected,
			requiredRecall: testCase.mustRecall?.length ?? 0,
			recalled: (testCase.mustRecall?.length ?? 0) - missingRecall.length,
			pollutedRecall: pollutedRecall.length,
			expectedOpenLoops: testCase.expectOpenLoops?.length ?? 0,
			coveredOpenLoops: (testCase.expectOpenLoops?.length ?? 0) - missingOpenLoops.length,
			expectedCurrentnessChecks: testCase.expectCurrentnessChecks?.length ?? 0,
			coveredCurrentnessChecks:
				(testCase.expectCurrentnessChecks?.length ?? 0) -
				missingCurrentnessChecks.length -
				staleCurrentFactViolations.length,
			staleCurrentFactViolations: staleCurrentFactViolations.length,
			actionGateExpectations:
				(testCase.expectActionGateIncludes?.length ?? 0) + (testCase.expectActionGateExcludes?.length ?? 0),
			satisfiedActionGateExpectations:
				(testCase.expectActionGateIncludes?.length ?? 0) +
				(testCase.expectActionGateExcludes?.length ?? 0) -
				actionGateMissing.length -
				actionGateUnexpected.length,
		});
	}

	const metrics = finalizeMetrics(totals);
	return {
		passed: caseResults.every((result) => casePassed(result)),
		cases: caseResults,
		metrics,
	};
}

export function formatAkashaLongitudinalMemoryEvalResult(result: AkashaLongitudinalMemoryEvalResult): string {
	const summary = [
		result.passed ? "Akasha longitudinal memory eval passed." : "Akasha longitudinal memory eval failed.",
		`Recall hit rate: ${formatRate(result.metrics.recallHitRate)} (${result.metrics.recalled}/${result.metrics.requiredRecall})`,
		`Pollution rate: ${formatRate(result.metrics.pollutionRate)} (${result.metrics.pollutedRecall}/${result.metrics.selected})`,
		`Open-loop coverage: ${formatRate(result.metrics.openLoopCoverage)} (${result.metrics.coveredOpenLoops}/${result.metrics.expectedOpenLoops})`,
		`Currentness coverage: ${formatRate(result.metrics.currentnessCoverage)} (${result.metrics.coveredCurrentnessChecks}/${result.metrics.expectedCurrentnessChecks})`,
		`Action-gate coverage: ${formatRate(result.metrics.actionGateCoverage)} (${result.metrics.satisfiedActionGateExpectations}/${result.metrics.actionGateExpectations})`,
	];
	if (result.passed) return summary.join("\n");
	return [...summary, ...result.cases.flatMap((testCase) => formatCaseFailures(testCase))].join("\n");
}

function casePassed(result: AkashaLongitudinalMemoryEvalCaseResult): boolean {
	return (
		result.missingRecall.length === 0 &&
		result.pollutedRecall.length === 0 &&
		result.missingOpenLoops.length === 0 &&
		result.missingCurrentnessChecks.length === 0 &&
		result.staleCurrentFactViolations.length === 0 &&
		result.actionGateMissing.length === 0 &&
		result.actionGateUnexpected.length === 0
	);
}

function formatCaseFailures(result: AkashaLongitudinalMemoryEvalCaseResult): string[] {
	const lines: string[] = [];
	const push = (label: string, values: string[]) => {
		if (values.length > 0) lines.push(`- ${result.caseName}: ${label} [${values.join(", ")}]`);
	};
	push("missing recall", result.missingRecall);
	push("polluted recall", result.pollutedRecall);
	push("missing open loops", result.missingOpenLoops);
	push("missing currentness checks", result.missingCurrentnessChecks);
	push("stale facts treated current", result.staleCurrentFactViolations);
	push("action gate missing", result.actionGateMissing);
	push("action gate unexpected", result.actionGateUnexpected);
	return lines;
}

function createEmptyMetrics(): AkashaLongitudinalMemoryEvalMetrics {
	return {
		requiredRecall: 0,
		recalled: 0,
		selected: 0,
		pollutedRecall: 0,
		expectedOpenLoops: 0,
		coveredOpenLoops: 0,
		expectedCurrentnessChecks: 0,
		coveredCurrentnessChecks: 0,
		staleCurrentFactViolations: 0,
		actionGateExpectations: 0,
		satisfiedActionGateExpectations: 0,
		recallHitRate: 1,
		pollutionRate: 0,
		openLoopCoverage: 1,
		currentnessCoverage: 1,
		actionGateCoverage: 1,
	};
}

function accumulateMetrics(
	totals: AkashaLongitudinalMemoryEvalMetrics,
	input: {
		selected: string[];
		requiredRecall: number;
		recalled: number;
		pollutedRecall: number;
		expectedOpenLoops: number;
		coveredOpenLoops: number;
		expectedCurrentnessChecks: number;
		coveredCurrentnessChecks: number;
		staleCurrentFactViolations: number;
		actionGateExpectations: number;
		satisfiedActionGateExpectations: number;
	},
): void {
	totals.selected += input.selected.length;
	totals.requiredRecall += input.requiredRecall;
	totals.recalled += input.recalled;
	totals.pollutedRecall += input.pollutedRecall;
	totals.expectedOpenLoops += input.expectedOpenLoops;
	totals.coveredOpenLoops += input.coveredOpenLoops;
	totals.expectedCurrentnessChecks += input.expectedCurrentnessChecks;
	totals.coveredCurrentnessChecks += Math.max(0, input.coveredCurrentnessChecks);
	totals.staleCurrentFactViolations += input.staleCurrentFactViolations;
	totals.actionGateExpectations += input.actionGateExpectations;
	totals.satisfiedActionGateExpectations += Math.max(0, input.satisfiedActionGateExpectations);
}

function finalizeMetrics(metrics: AkashaLongitudinalMemoryEvalMetrics): AkashaLongitudinalMemoryEvalMetrics {
	return {
		...metrics,
		recallHitRate: rate(metrics.recalled, metrics.requiredRecall, 1),
		pollutionRate: rate(metrics.pollutedRecall, metrics.selected, 0),
		openLoopCoverage: rate(metrics.coveredOpenLoops, metrics.expectedOpenLoops, 1),
		currentnessCoverage: rate(metrics.coveredCurrentnessChecks, metrics.expectedCurrentnessChecks, 1),
		actionGateCoverage: rate(metrics.satisfiedActionGateExpectations, metrics.actionGateExpectations, 1),
	};
}

function resolveSemanticSeeds(
	seeds: AkashaLongitudinalMemoryEvalOptions["semanticSeeds"],
	queryText: string | undefined,
): AkashaSemanticMemorySeed[] {
	if (typeof seeds === "function") return seeds(queryText);
	return seeds ?? [];
}

function normalizeNow(now: Date | string | undefined): Date {
	if (now instanceof Date) return now;
	if (typeof now === "string") return new Date(now);
	return new Date();
}

function rate(numerator: number, denominator: number, emptyValue: number): number {
	if (denominator <= 0) return emptyValue;
	return Number((numerator / denominator).toFixed(4));
}

function formatRate(value: number): string {
	return `${Math.round(value * 1000) / 10}%`;
}

function stateEventWasSelected(
	state: { observedEventId: string; latestEventId: string; sourceEventIds: string[] },
	selectedIds: Set<string>,
): boolean {
	return (
		selectedIds.has(state.observedEventId) ||
		selectedIds.has(state.latestEventId) ||
		state.sourceEventIds.some((id) => selectedIds.has(id))
	);
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

function isString(value: string | undefined): value is string {
	return typeof value === "string" && value.length > 0;
}
