import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { buildAkashaActionGateContext } from "./action-gate.js";
import { projectAkashaGovernedEvents } from "./governance-projection.js";
import {
	type AkashaLongitudinalMemoryEvalCase,
	type AkashaLongitudinalMemoryEvalOptions,
	type AkashaLongitudinalMemoryEvalResult,
	runAkashaLongitudinalMemoryEval,
} from "./longitudinal-memory-eval.js";
import { type AkashaSchemaIssue, parseAkashaJsonl } from "./schema.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaDogfoodMemoryEvalBudget {
	minRecallHitRate?: number;
	maxPollutionRate?: number;
	minOpenLoopCoverage?: number;
	minCurrentnessCoverage?: number;
	minActionGateCoverage?: number;
	maxEstimatedActionGateTokens?: number;
	maxDurationMs?: number;
	maxParseIssues?: number;
}

export interface AkashaDogfoodMemoryEvalCorpus {
	name: string;
	cases: AkashaLongitudinalMemoryEvalCase[];
	events?: AkashaEvent[];
	eventLogPaths?: string[];
	eventLogContents?: string[];
	cwd?: string;
	now?: Date | string;
	defaultLimit?: number;
	maxTraces?: number;
	semanticSeeds?: AkashaLongitudinalMemoryEvalOptions["semanticSeeds"];
	budget?: AkashaDogfoodMemoryEvalBudget;
}

export interface AkashaDogfoodMemoryEvalCorpusResult {
	corpusName: string;
	passed: boolean;
	eventCount: number;
	sourceCount: number;
	parseIssues: AkashaSchemaIssue[];
	longitudinal: AkashaLongitudinalMemoryEvalResult;
	durationMs: number;
	estimatedActionGateTokens: number;
	budgetFailures: string[];
}

export interface AkashaDogfoodMemoryEvalMetrics {
	corpusCount: number;
	eventCount: number;
	sourceCount: number;
	parseIssueCount: number;
	failedCorpusCount: number;
	maxDurationMs: number;
	maxEstimatedActionGateTokens: number;
}

export interface AkashaDogfoodMemoryEvalResult {
	passed: boolean;
	corpora: AkashaDogfoodMemoryEvalCorpusResult[];
	metrics: AkashaDogfoodMemoryEvalMetrics;
}

export interface AkashaDogfoodMemoryEvalOptions {
	cwd?: string;
	now?: Date | string;
	defaultBudget?: AkashaDogfoodMemoryEvalBudget;
	defaultLimit?: number;
	maxTraces?: number;
}

export function runAkashaDogfoodMemoryEval(
	corpora: AkashaDogfoodMemoryEvalCorpus[],
	options: AkashaDogfoodMemoryEvalOptions = {},
): AkashaDogfoodMemoryEvalResult {
	const results = corpora.map((corpus) => runCorpus(corpus, options));
	const metrics = summarizeDogfoodMetrics(results);
	return {
		passed: results.every((result) => result.passed),
		corpora: results,
		metrics,
	};
}

export function formatAkashaDogfoodMemoryEvalResult(result: AkashaDogfoodMemoryEvalResult): string {
	const summary = [
		result.passed ? "Akasha dogfood memory eval passed." : "Akasha dogfood memory eval failed.",
		`Corpora: ${result.metrics.corpusCount}`,
		`Events: ${result.metrics.eventCount}`,
		`Parse issues: ${result.metrics.parseIssueCount}`,
		`Max action-gate tokens: ${result.metrics.maxEstimatedActionGateTokens}`,
		`Max duration: ${Math.round(result.metrics.maxDurationMs)}ms`,
	];
	if (result.passed) return summary.join("\n");
	return [
		...summary,
		...result.corpora.flatMap((corpus) => {
			const failures: string[] = [];
			if (!corpus.longitudinal.passed) failures.push(`- ${corpus.corpusName}: longitudinal expectations failed`);
			for (const failure of corpus.budgetFailures) failures.push(`- ${corpus.corpusName}: ${failure}`);
			for (const issue of corpus.parseIssues) {
				failures.push(`- ${corpus.corpusName}: parse issue ${issue.line ?? "unknown"} ${issue.message}`);
			}
			return failures;
		}),
	].join("\n");
}

function runCorpus(
	corpus: AkashaDogfoodMemoryEvalCorpus,
	options: AkashaDogfoodMemoryEvalOptions,
): AkashaDogfoodMemoryEvalCorpusResult {
	const start = performance.now();
	const loaded = loadCorpusEvents(corpus);
	const now = corpus.now ?? options.now;
	const longitudinal = runAkashaLongitudinalMemoryEval(loaded.events, corpus.cases, {
		cwd: corpus.cwd ?? options.cwd,
		defaultLimit: corpus.defaultLimit ?? options.defaultLimit,
		maxTraces: corpus.maxTraces ?? options.maxTraces,
		now,
		semanticSeeds: corpus.semanticSeeds,
	});
	const durationMs = performance.now() - start;
	const estimatedActionGateTokens = estimateCorpusActionGateTokens(loaded.events, now);
	const budgetFailures = evaluateBudget(
		{
			...options.defaultBudget,
			...corpus.budget,
		},
		longitudinal,
		{
			durationMs,
			estimatedActionGateTokens,
			parseIssueCount: loaded.parseIssues.length,
		},
	);
	return {
		corpusName: corpus.name,
		passed: longitudinal.passed && loaded.parseIssues.length === 0 && budgetFailures.length === 0,
		eventCount: loaded.events.length,
		sourceCount: loaded.sourceCount,
		parseIssues: loaded.parseIssues,
		longitudinal,
		durationMs,
		estimatedActionGateTokens,
		budgetFailures,
	};
}

function loadCorpusEvents(corpus: AkashaDogfoodMemoryEvalCorpus): {
	events: AkashaEvent[];
	parseIssues: AkashaSchemaIssue[];
	sourceCount: number;
} {
	const directEvents = corpus.events ?? [];
	const contents = [
		...(corpus.eventLogContents ?? []),
		...(corpus.eventLogPaths ?? []).map((path) => readFileSync(path, "utf-8")),
	];
	const parsed = contents.map((content) => parseAkashaJsonl(content));
	return {
		events: [...directEvents, ...parsed.flatMap((item) => item.events)].sort(compareEvents),
		parseIssues: parsed.flatMap((item) => item.issues),
		sourceCount: directEvents.length > 0 ? contents.length + 1 : contents.length,
	};
}

function estimateCorpusActionGateTokens(events: AkashaEvent[], now: Date | string | undefined): number {
	const governed = projectAkashaGovernedEvents(events).events;
	const text = buildAkashaActionGateContext({ sessionEvents: governed, now: normalizeNow(now) })?.text ?? "";
	return estimateTokens(text);
}

function evaluateBudget(
	budget: AkashaDogfoodMemoryEvalBudget,
	longitudinal: AkashaLongitudinalMemoryEvalResult,
	actual: {
		durationMs: number;
		estimatedActionGateTokens: number;
		parseIssueCount: number;
	},
): string[] {
	const failures: string[] = [];
	pushMin(failures, "recall hit rate", longitudinal.metrics.recallHitRate, budget.minRecallHitRate);
	pushMax(failures, "pollution rate", longitudinal.metrics.pollutionRate, budget.maxPollutionRate);
	pushMin(failures, "open-loop coverage", longitudinal.metrics.openLoopCoverage, budget.minOpenLoopCoverage);
	pushMin(failures, "currentness coverage", longitudinal.metrics.currentnessCoverage, budget.minCurrentnessCoverage);
	pushMin(failures, "action-gate coverage", longitudinal.metrics.actionGateCoverage, budget.minActionGateCoverage);
	pushMax(failures, "action-gate tokens", actual.estimatedActionGateTokens, budget.maxEstimatedActionGateTokens);
	pushMax(failures, "duration ms", actual.durationMs, budget.maxDurationMs);
	pushMax(failures, "parse issues", actual.parseIssueCount, budget.maxParseIssues);
	return failures;
}

function summarizeDogfoodMetrics(results: AkashaDogfoodMemoryEvalCorpusResult[]): AkashaDogfoodMemoryEvalMetrics {
	return {
		corpusCount: results.length,
		eventCount: sum(results.map((result) => result.eventCount)),
		sourceCount: sum(results.map((result) => result.sourceCount)),
		parseIssueCount: sum(results.map((result) => result.parseIssues.length)),
		failedCorpusCount: results.filter((result) => !result.passed).length,
		maxDurationMs: Math.max(0, ...results.map((result) => result.durationMs)),
		maxEstimatedActionGateTokens: Math.max(0, ...results.map((result) => result.estimatedActionGateTokens)),
	};
}

function pushMin(failures: string[], label: string, actual: number, expected: number | undefined): void {
	if (expected === undefined || actual >= expected) return;
	failures.push(`${label} ${formatNumber(actual)} is below budget ${formatNumber(expected)}`);
}

function pushMax(failures: string[], label: string, actual: number, expected: number | undefined): void {
	if (expected === undefined || actual <= expected) return;
	failures.push(`${label} ${formatNumber(actual)} exceeds budget ${formatNumber(expected)}`);
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function normalizeNow(now: Date | string | undefined): Date | undefined {
	if (now instanceof Date) return now;
	if (typeof now === "string") return new Date(now);
	return undefined;
}

function compareEvents(a: AkashaEvent, b: AkashaEvent): number {
	return a.sequence - b.sequence || a.eventTime.localeCompare(b.eventTime) || a.eventId.localeCompare(b.eventId);
}

function sum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? `${value}` : value.toFixed(3);
}
